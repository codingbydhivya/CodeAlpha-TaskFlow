const Project = require('../models/Project');
const Task = require('../models/Task');
const Comment = require('../models/Comment');

const STATUSES = ['todo', 'in-progress', 'completed'];
const popTask = (q) => q.populate('assignedTo', 'name email').populate('createdBy', 'name');

async function requireMember(projectId, userId) {
  return Project.findOne({ _id: projectId, members: userId });
}

async function requireAssigneeInProject(project, assignedTo) {
  return !assignedTo || project.members.some((m) => String(m) === String(assignedTo));
}

// Loads a task and verifies the current user belongs to its project
async function loadTask(req, res) {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404).json({ message: 'Task not found' });
    return {};
  }
  const project = await requireMember(task.project, req.user._id);
  if (!project) {
    res.status(404).json({ message: 'Task not found' });
    return {};
  }
  return { task, project };
}

exports.listForProject = async (req, res) => {
  const project = await requireMember(req.params.projectId, req.user._id);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const tasks = await popTask(Task.find({ project: project._id }).sort({ createdAt: 1 }));
  res.json(tasks);
};

exports.create = async (req, res) => {
  const project = await requireMember(req.params.projectId, req.user._id);
  if (!project) return res.status(404).json({ message: 'Project not found' });

  const { title, description, status, assignedTo } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ message: 'Task title is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status' });
  if (!(await requireAssigneeInProject(project, assignedTo)))
    return res.status(400).json({ message: 'Assignee must be a project member' });

  const task = await Task.create({
    title,
    description,
    status: status || 'todo',
    assignedTo: assignedTo || null,
    project: project._id,
    createdBy: req.user._id,
  });
  const full = await popTask(Task.findById(task._id));
  req.app.get('io').to(`project:${project._id}`).emit('task:created', full);
  res.status(201).json(full);
};

exports.update = async (req, res) => {
  const { task, project } = await loadTask(req, res);
  if (!task) return;

  const { title, description, status, assignedTo } = req.body;
  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ message: 'Task title is required' });
    task.title = title;
  }
  if (description !== undefined) task.description = description;
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    task.status = status;
  }
  if (assignedTo !== undefined) {
    if (!(await requireAssigneeInProject(project, assignedTo)))
      return res.status(400).json({ message: 'Assignee must be a project member' });
    task.assignedTo = assignedTo || null;
  }
  await task.save();

  const full = await popTask(Task.findById(task._id));
  req.app.get('io').to(`project:${project._id}`).emit('task:updated', full);
  res.json(full);
};

exports.remove = async (req, res) => {
  const { task, project } = await loadTask(req, res);
  if (!task) return;
  await Comment.deleteMany({ task: task._id });
  await task.deleteOne();
  req.app.get('io').to(`project:${project._id}`).emit('task:deleted', { _id: task._id, project: project._id });
  res.json({ message: 'Task deleted' });
};

exports.listComments = async (req, res) => {
  const { task } = await loadTask(req, res);
  if (!task) return;
  const comments = await Comment.find({ task: task._id }).sort({ createdAt: 1 }).populate('user', 'name');
  res.json(comments);
};

exports.addComment = async (req, res) => {
  const { task, project } = await loadTask(req, res);
  if (!task) return;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ message: 'Comment cannot be empty' });

  const comment = await Comment.create({ task: task._id, user: req.user._id, text });
  const full = await Comment.findById(comment._id).populate('user', 'name');
  req.app.get('io').to(`project:${project._id}`).emit('comment:created', full);
  res.status(201).json(full);
};

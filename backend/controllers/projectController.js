const Project = require('../models/Project');
const Task = require('../models/Task');
const Comment = require('../models/Comment');
const User = require('../models/User');

const populate = (q) => q.populate('owner', 'name email').populate('members', 'name email');

// Loads a project only if the current user is a member
async function memberProject(req, res) {
  const project = await Project.findOne({ _id: req.params.id, members: req.user._id });
  if (!project) {
    res.status(404).json({ message: 'Project not found' });
    return null;
  }
  return project;
}

async function withStats(projects) {
  const ids = projects.map((p) => p._id);
  const rows = await Task.aggregate([
    { $match: { project: { $in: ids } } },
    { $group: { _id: { project: '$project', status: '$status' }, n: { $sum: 1 } } },
  ]);
  return projects.map((p) => {
    const stats = { todo: 0, 'in-progress': 0, completed: 0 };
    rows.filter((r) => String(r._id.project) === String(p._id)).forEach((r) => (stats[r._id.status] = r.n));
    return { ...p.toObject(), stats };
  });
}

exports.list = async (req, res) => {
  const projects = await populate(Project.find({ members: req.user._id }).sort({ updatedAt: -1 }));
  res.json(await withStats(projects));
};

exports.create = async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Project name is required' });
  const project = await Project.create({
    name,
    description,
    owner: req.user._id,
    members: [req.user._id],
  });
  const full = await populate(Project.findById(project._id));
  res.status(201).json((await withStats([full]))[0]);
};

exports.get = async (req, res) => {
  const found = await memberProject(req, res);
  if (!found) return;
  const project = await populate(Project.findById(found._id));
  res.json((await withStats([project]))[0]);
};

exports.update = async (req, res) => {
  const project = await memberProject(req, res);
  if (!project) return;
  if (String(project.owner) !== String(req.user._id))
    return res.status(403).json({ message: 'Only the project owner can edit the project' });

  if (req.body.name !== undefined) {
    if (!req.body.name.trim()) return res.status(400).json({ message: 'Project name is required' });
    project.name = req.body.name;
  }
  if (req.body.description !== undefined) project.description = req.body.description;
  await project.save();

  const full = await populate(Project.findById(project._id));
  const payload = (await withStats([full]))[0];
  req.app.get('io').to(`project:${project._id}`).emit('project:updated', payload);
  res.json(payload);
};

exports.remove = async (req, res) => {
  const project = await memberProject(req, res);
  if (!project) return;
  if (String(project.owner) !== String(req.user._id))
    return res.status(403).json({ message: 'Only the project owner can delete the project' });

  const tasks = await Task.find({ project: project._id }).select('_id');
  await Comment.deleteMany({ task: { $in: tasks.map((t) => t._id) } });
  await Task.deleteMany({ project: project._id });
  await project.deleteOne();

  req.app.get('io').to(`project:${project._id}`).emit('project:deleted', { _id: project._id });
  res.json({ message: 'Project deleted' });
};

exports.addMember = async (req, res) => {
  const project = await memberProject(req, res);
  if (!project) return;
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ message: 'No user registered with that email' });
  if (project.members.some((m) => String(m) === String(user._id)))
    return res.status(409).json({ message: 'User is already a member' });

  project.members.push(user._id);
  await project.save();

  const full = await populate(Project.findById(project._id));
  const payload = (await withStats([full]))[0];
  const io = req.app.get('io');
  io.to(`project:${project._id}`).emit('project:updated', payload);
  io.to(`user:${user._id}`).emit('project:added', payload); // new member sees it instantly
  res.json(payload);
};

exports.removeMember = async (req, res) => {
  const project = await memberProject(req, res);
  if (!project) return;
  const { userId } = req.params;
  const isOwner = String(project.owner) === String(req.user._id);
  const isSelf = String(userId) === String(req.user._id);

  if (!isOwner && !isSelf) return res.status(403).json({ message: 'Only the owner can remove other members' });
  if (String(project.owner) === String(userId)) return res.status(400).json({ message: 'The owner cannot be removed' });

  project.members = project.members.filter((m) => String(m) !== String(userId));
  await project.save();
  await Task.updateMany({ project: project._id, assignedTo: userId }, { assignedTo: null });

  const full = await populate(Project.findById(project._id));
  const payload = (await withStats([full]))[0];
  const io = req.app.get('io');
  io.to(`project:${project._id}`).emit('project:updated', payload);
  io.to(`user:${userId}`).emit('project:removed', { _id: project._id });
  res.json(payload);
};

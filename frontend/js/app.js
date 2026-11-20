(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    token: localStorage.getItem('tf_token'),
    user: JSON.parse(localStorage.getItem('tf_user') || 'null'),
    projects: [],
    current: null, // current project object
    tasks: [],
    editingTask: null,
    editingProject: null, // null = creating
    socket: null,
    authMode: 'login',
  };
  const STATUS_ORDER = ['todo', 'in-progress', 'completed'];
  const STATUS_LABEL = { todo: 'To Do', 'in-progress': 'In Progress', completed: 'Completed' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (name) =>
    (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  // ---------- API ----------
  async function api(path, method = 'GET', body) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) {
      logout(true);
      throw new Error('Session expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.message || 'Request failed');
    return data;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---------- Auth ----------
  function setAuthMode(mode) {
    state.authMode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
    $('auth-name').classList.toggle('hidden', mode !== 'register');
    $('auth-name').required = mode === 'register';
    $('auth-submit').textContent = mode === 'register' ? 'Create account' : 'Log in';
    $('auth-error').textContent = '';
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.tab)));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    try {
      const payload = { email: $('auth-email').value, password: $('auth-password').value };
      if (state.authMode === 'register') payload.name = $('auth-name').value;
      const data = await api('/auth/' + state.authMode, 'POST', payload);
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('tf_token', data.token);
      localStorage.setItem('tf_user', JSON.stringify(data.user));
      $('auth-form').reset();
      await startApp();
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  });

  function logout(silent) {
    if (state.token && !silent) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }).catch(() => {});
    localStorage.removeItem('tf_token');
    localStorage.removeItem('tf_user');
    state.token = null;
    state.user = null;
    state.projects = [];
    state.current = null;
    state.tasks = [];
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    $('app-view').classList.add('hidden');
    $('auth-view').classList.remove('hidden');
    closeModals();
  }
  $('logout-btn').addEventListener('click', () => logout(false));

  // ---------- Socket ----------
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('connect', () => {
      setConn(true);
      if (state.current) {
        socket.emit('project:join', state.current._id);
        loadTasks(); // resync anything missed while offline
      }
    });
    socket.on('disconnect', () => setConn(false));
    socket.on('connect_error', () => setConn(false));

    socket.on('task:created', (task) => {
      if (!state.current || task.project !== state.current._id) return;
      if (!state.tasks.some((t) => t._id === task._id)) state.tasks.push(task);
      renderBoard(task._id);
      if (task.createdBy && task.createdBy._id !== state.user._id) toast(`${task.createdBy.name} added "${task.title}"`);
    });
    socket.on('task:updated', (task) => {
      if (!state.current || task.project !== state.current._id) return;
      const i = state.tasks.findIndex((t) => t._id === task._id);
      if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
      renderBoard(task._id);
      if (state.editingTask && state.editingTask._id === task._id) state.editingTask = task;
    });
    socket.on('task:deleted', ({ _id }) => {
      state.tasks = state.tasks.filter((t) => t._id !== _id);
      renderBoard();
      if (state.editingTask && state.editingTask._id === _id) {
        closeModals();
        toast('This task was deleted by someone else');
      }
    });
    socket.on('comment:created', (c) => {
      if (state.editingTask && state.editingTask._id === c.task) appendComment(c);
    });
    socket.on('project:updated', (p) => {
      const i = state.projects.findIndex((x) => x._id === p._id);
      if (i >= 0) state.projects[i] = p;
      if (state.current && state.current._id === p._id) { state.current = p; renderProjectHeader(); }
      renderSidebar();
      if (!$('members-modal').classList.contains('hidden')) renderMembers();
    });
    socket.on('project:deleted', ({ _id }) => dropProject(_id, 'A project you were in was deleted'));
    socket.on('project:removed', ({ _id }) => dropProject(_id, 'You were removed from a project'));
    socket.on('project:added', (p) => {
      if (!state.projects.some((x) => x._id === p._id)) state.projects.unshift(p);
      renderSidebar();
      toast(`You were added to "${p.name}"`);
    });
  }

  function setConn(on) {
    const el = $('conn');
    el.className = 'conn ' + (on ? 'on' : 'off');
    el.textContent = on ? '● live' : '● offline';
  }

  function dropProject(id, message) {
    state.projects = state.projects.filter((p) => p._id !== id);
    if (state.current && state.current._id === id) {
      state.current = null;
      state.tasks = [];
      closeModals();
      showProjectView(false);
    }
    renderSidebar();
    toast(message);
  }

  // ---------- Projects ----------
  async function loadProjects() {
    state.projects = await api('/projects');
    renderSidebar();
  }

  function renderSidebar() {
    const list = $('project-list');
    if (!state.projects.length) {
      list.innerHTML = '<p class="empty-note">No projects yet. Click + to create one.</p>';
      return;
    }
    list.innerHTML = state.projects
      .map((p) => {
        const total = p.stats.todo + p.stats['in-progress'] + p.stats.completed;
        const active = state.current && state.current._id === p._id ? 'active' : '';
        return `<button class="project-item ${active}" data-id="${p._id}">${esc(p.name)}<small>${p.stats.completed}/${total} done &middot; ${p.members.length} member${p.members.length === 1 ? '' : 's'}</small></button>`;
      })
      .join('');
    list.querySelectorAll('.project-item').forEach((b) =>
      b.addEventListener('click', () => {
        openProject(b.dataset.id);
        $('sidebar').classList.remove('open');
      })
    );
  }

  async function openProject(id) {
    try {
      if (state.current && state.socket) state.socket.emit('project:leave', state.current._id);
      state.current = await api('/projects/' + id);
      showProjectView(true);
      renderProjectHeader();
      if (state.socket) state.socket.emit('project:join', id);
      await loadTasks();
      renderSidebar();
    } catch (err) {
      toast(err.message);
    }
  }

  function showProjectView(show) {
    $('project-view').classList.toggle('hidden', !show);
    $('empty-state').classList.toggle('hidden', show);
  }

  function renderProjectHeader() {
    const p = state.current;
    if (!p) return;
    $('project-title').textContent = p.name;
    $('project-desc').textContent = p.description || 'No description';
    const isOwner = p.owner._id === state.user._id;
    $('edit-project-btn').classList.toggle('hidden', !isOwner);
    $('delete-project-btn').classList.toggle('hidden', !isOwner);
  }

  $('new-project-btn').addEventListener('click', () => openProjectModal(null));
  $('edit-project-btn').addEventListener('click', () => openProjectModal(state.current));

  function openProjectModal(project) {
    state.editingProject = project;
    $('project-modal-title').textContent = project ? 'Edit project' : 'New project';
    $('project-name').value = project ? project.name : '';
    $('project-description').value = project ? project.description : '';
    $('project-error').textContent = '';
    $('project-modal').classList.remove('hidden');
    $('project-name').focus();
  }

  $('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('project-name').value, description: $('project-description').value };
    try {
      if (state.editingProject) {
        const p = await api('/projects/' + state.editingProject._id, 'PUT', body);
        const i = state.projects.findIndex((x) => x._id === p._id);
        if (i >= 0) state.projects[i] = p;
        state.current = p;
        renderProjectHeader();
        renderSidebar();
      } else {
        const p = await api('/projects', 'POST', body);
        state.projects.unshift(p);
        renderSidebar();
        await openProject(p._id);
      }
      closeModals();
    } catch (err) {
      $('project-error').textContent = err.message;
    }
  });

  $('delete-project-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${state.current.name}" and all its tasks? This cannot be undone.`)) return;
    try {
      await api('/projects/' + state.current._id, 'DELETE');
      dropProject(state.current._id, 'Project deleted');
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Members ----------
  $('members-btn').addEventListener('click', () => {
    $('member-error').textContent = '';
    renderMembers();
    $('members-modal').classList.remove('hidden');
  });

  function renderMembers() {
    const p = state.current;
    if (!p) return;
    const isOwner = p.owner._id === state.user._id;
    $('member-list').innerHTML = p.members
      .map((m) => {
        const owner = m._id === p.owner._id;
        const canRemove = !owner && (isOwner || m._id === state.user._id);
        return `<li><div class="avatar sm">${esc(initials(m.name))}</div>
          <div class="info"><strong>${esc(m.name)}</strong><small>${esc(m.email)}</small></div>
          ${owner ? '<span class="badge">Owner</span>' : ''}
          ${canRemove ? `<button class="btn danger-ghost small" data-remove="${m._id}">${m._id === state.user._id ? 'Leave' : 'Remove'}</button>` : ''}</li>`;
      })
      .join('');
    $('member-list').querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api(`/projects/${p._id}/members/${b.dataset.remove}`, 'DELETE');
          if (b.dataset.remove === state.user._id) { dropProject(p._id, 'You left the project'); closeModals(); }
        } catch (err) {
          $('member-error').textContent = err.message;
        }
      })
    );
  }

  $('member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('member-error').textContent = '';
    try {
      const p = await api(`/projects/${state.current._id}/members`, 'POST', { email: $('member-email').value });
      state.current = p;
      $('member-email').value = '';
      renderMembers();
    } catch (err) {
      $('member-error').textContent = err.message;
    }
  });

  // ---------- Tasks / Board ----------
  async function loadTasks() {
    if (!state.current) return;
    state.tasks = await api(`/projects/${state.current._id}/tasks`);
    renderBoard();
  }

  function recomputeStats() {
    if (!state.current) return;
    const stats = { todo: 0, 'in-progress': 0, completed: 0 };
    state.tasks.forEach((t) => stats[t.status]++);
    state.current.stats = stats;
    const i = state.projects.findIndex((p) => p._id === state.current._id);
    if (i >= 0) state.projects[i].stats = stats;
    renderSidebar();
  }

  function renderBoard(flashId) {
    STATUS_ORDER.forEach((s) => {
      const body = $('col-' + s);
      const items = state.tasks.filter((t) => t.status === s);
      $('count-' + s).textContent = items.length;
      body.innerHTML = items.map(cardHTML).join('');
    });

    document.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-move]')) return;
        const t = state.tasks.find((x) => x._id === card.dataset.id);
        if (t) openTaskModal(t);
      });
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    document.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => moveTask(b.dataset.id, b.dataset.move))
    );

    if (flashId) {
      const el = document.querySelector(`.card[data-id="${flashId}"]`);
      if (el) el.classList.add('flash');
    }

    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === 'completed').length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('progress-bar').style.width = pct + '%';
    $('progress-text').textContent = `${done}/${total} tasks completed (${pct}%)`;
    recomputeStats();
  }

  function cardHTML(t) {
    const idx = STATUS_ORDER.indexOf(t.status);
    const prev = idx > 0 ? `<button data-move="${STATUS_ORDER[idx - 1]}" data-id="${t._id}" title="Move to ${STATUS_LABEL[STATUS_ORDER[idx - 1]]}">&larr;</button>` : '';
    const next = idx < 2 ? `<button data-move="${STATUS_ORDER[idx + 1]}" data-id="${t._id}" title="Move to ${STATUS_LABEL[STATUS_ORDER[idx + 1]]}">&rarr;</button>` : '';
    const who = t.assignedTo
      ? `<div class="avatar sm" title="${esc(t.assignedTo.name)}">${esc(initials(t.assignedTo.name))}</div><span>${esc(t.assignedTo.name)}</span>`
      : '<span>Unassigned</span>';
    return `<div class="card" draggable="true" data-id="${t._id}" data-status="${t.status}">
      <h4>${esc(t.title)}</h4>
      ${t.description ? `<p>${esc(t.description.length > 90 ? t.description.slice(0, 90) + '…' : t.description)}</p>` : ''}
      <div class="card-foot">${who}<div class="move">${prev}${next}</div></div></div>`;
  }

  async function moveTask(id, status) {
    const t = state.tasks.find((x) => x._id === id);
    if (!t || t.status === status) return;
    const old = t.status;
    t.status = status; // optimistic
    renderBoard(id);
    try {
      await api('/tasks/' + id, 'PUT', { status });
    } catch (err) {
      t.status = old;
      renderBoard();
      toast(err.message);
    }
  }

  // Drag & drop targets
  document.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveTask(id, col.dataset.status);
    });
  });

  // ---------- Task modal ----------
  $('add-task-btn').addEventListener('click', () => openTaskModal(null));

  function openTaskModal(task) {
    state.editingTask = task;
    $('task-modal-title').textContent = task ? 'Edit task' : 'New task';
    $('task-title').value = task ? task.title : '';
    $('task-description').value = task ? task.description : '';
    $('task-status').value = task ? task.status : 'todo';
    $('task-error').textContent = '';
    $('task-assignee').innerHTML =
      '<option value="">Unassigned</option>' +
      state.current.members.map((m) => `<option value="${m._id}">${esc(m.name)}</option>`).join('');
    $('task-assignee').value = task && task.assignedTo ? task.assignedTo._id : '';
    $('task-delete').classList.toggle('hidden', !task);
    $('comments-section').classList.toggle('hidden', !task);
    $('comment-list').innerHTML = '';
    $('task-modal').classList.remove('hidden');
    $('task-title').focus();
    if (task) loadComments(task._id);
  }

  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: $('task-title').value,
      description: $('task-description').value,
      status: $('task-status').value,
      assignedTo: $('task-assignee').value || null,
    };
    try {
      if (state.editingTask) await api('/tasks/' + state.editingTask._id, 'PUT', body);
      else await api(`/projects/${state.current._id}/tasks`, 'POST', body);
      closeModals(); // the board is updated by the socket event
    } catch (err) {
      $('task-error').textContent = err.message;
    }
  });

  $('task-delete').addEventListener('click', async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await api('/tasks/' + state.editingTask._id, 'DELETE');
      closeModals();
    } catch (err) {
      $('task-error').textContent = err.message;
    }
  });

  // ---------- Comments ----------
  async function loadComments(taskId) {
    try {
      const comments = await api(`/tasks/${taskId}/comments`);
      $('comment-list').innerHTML = '';
      comments.forEach(appendComment);
    } catch (err) {
      toast(err.message);
    }
  }

  function appendComment(c) {
    const list = $('comment-list');
    if (list.querySelector(`[data-cid="${c._id}"]`)) return; // avoid duplicates (REST + socket)
    const div = document.createElement('div');
    div.className = 'comment';
    div.dataset.cid = c._id;
    div.innerHTML = `<small><strong>${esc(c.user ? c.user.name : 'Unknown')}</strong> &middot; ${new Date(c.createdAt).toLocaleString()}</small>${esc(c.text)}`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  $('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('comment-input').value.trim();
    if (!text || !state.editingTask) return;
    try {
      const c = await api(`/tasks/${state.editingTask._id}/comments`, 'POST', { text });
      $('comment-input').value = '';
      appendComment(c);
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Modals / misc ----------
  function closeModals() {
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    state.editingTask = null;
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); })
  );
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  $('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  // ---------- Boot ----------
  async function startApp() {
    $('auth-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = state.user.name;
    $('user-email').textContent = state.user.email;
    $('user-avatar').textContent = initials(state.user.name);
    showProjectView(false);
    connectSocket();
    try {
      await loadProjects();
    } catch (err) {
      toast(err.message);
    }
  }

  (async function init() {
    setAuthMode('login');
    if (!state.token) return $('auth-view').classList.remove('hidden');
    try {
      const { user } = await api('/auth/me');
      state.user = user;
      await startApp();
    } catch (err) {
      logout(true);
    }
  })();
})();

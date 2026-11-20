const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Project = require('../models/Project');

module.exports = function initSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });

  // Authenticate every socket with the same JWT used for the REST API
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.id;
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Personal room: lets us notify a user when they are added to / removed from a project
    socket.join(`user:${socket.userId}`);

    socket.on('project:join', async (projectId, ack) => {
      try {
        const isMember = await Project.exists({ _id: projectId, members: socket.userId });
        if (isMember) socket.join(`project:${projectId}`);
        if (typeof ack === 'function') ack(!!isMember);
      } catch (err) {
        if (typeof ack === 'function') ack(false);
      }
    });

    socket.on('project:leave', (projectId) => {
      socket.leave(`project:${projectId}`);
    });
  });

  return io;
};

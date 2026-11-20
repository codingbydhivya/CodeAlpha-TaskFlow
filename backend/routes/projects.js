const router = require('express').Router();
const { asyncHandler: h, protect } = require('../middleware/auth');
const projects = require('../controllers/projectController');
const tasks = require('../controllers/taskController');

router.use(protect);

router.get('/', h(projects.list));
router.post('/', h(projects.create));
router.get('/:id', h(projects.get));
router.put('/:id', h(projects.update));
router.delete('/:id', h(projects.remove));

router.post('/:id/members', h(projects.addMember));
router.delete('/:id/members/:userId', h(projects.removeMember));

router.get('/:projectId/tasks', h(tasks.listForProject));
router.post('/:projectId/tasks', h(tasks.create));

module.exports = router;

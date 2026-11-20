const router = require('express').Router();
const { asyncHandler: h, protect } = require('../middleware/auth');
const tasks = require('../controllers/taskController');

router.use(protect);

router.put('/:id', h(tasks.update));
router.delete('/:id', h(tasks.remove));
router.get('/:id/comments', h(tasks.listComments));
router.post('/:id/comments', h(tasks.addComment));

module.exports = router;

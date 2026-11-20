const router = require('express').Router();
const { asyncHandler, protect } = require('../middleware/auth');
const c = require('../controllers/authController');

router.post('/register', asyncHandler(c.register));
router.post('/login', asyncHandler(c.login));
router.get('/me', protect, c.me);
// Logout is stateless with JWT: the client discards its token.
router.post('/logout', protect, (req, res) => res.json({ message: 'Logged out' }));

module.exports = router;

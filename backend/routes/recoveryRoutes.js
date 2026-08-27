const express = require("express");
const { getRecovery } = require("../controllers/recoveryController");

const router = express.Router();

router.get("/", getRecovery);

module.exports = router;

const { createSqliteStorage, DATABASE_FILE } = require("./sqlite");

function createStorage(options) {
  return createSqliteStorage(options);
}

module.exports = { createStorage, DATABASE_FILE };

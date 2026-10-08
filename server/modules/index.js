// A new feature is a folder in modules/ plus one line here.
// Load order is resolved from dependsOn, so the order of this list is free.
module.exports = [
  require("./auth"),
  require("./products"),
  require("./orders"),
  require("./clients"),
  require("./chat"),
  require("./telegram"),
  require("./catalog-pdf"),
  require("./order-invoice"),
];

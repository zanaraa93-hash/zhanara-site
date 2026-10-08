const path = require("path");

const FONTS_DIR = path.join(__dirname, "fonts");
const FONT_FILES = {
  serif: "CormorantGaramond-SemiBold.ttf",
  sans: "NotoSans-Regular.ttf",
  "sans-bold": "NotoSans-SemiBold.ttf",
};

const fontPaths = () => Object.fromEntries(Object.entries(FONT_FILES).map(([name, file]) => [name, path.join(FONTS_DIR, file)]));

module.exports = { fontPaths };

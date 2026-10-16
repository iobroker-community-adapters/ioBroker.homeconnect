const { deleteFoldersRecursive, npmInstall, buildReact, copyFiles } = require("@iobroker/build-tools");
const src = `${__dirname}/src-admin/`;

function clean() {
  // Only the generated component output — never touch the hand-maintained admin/ files
  // (jsonConfig.json, i18n/, the icon).
  deleteFoldersRecursive(`${__dirname}/admin/custom`);
  deleteFoldersRecursive(`${src}build`);
}
function copyAllFiles() {
  // Module-Federation Vite output: the remote entry + its referenced asset chunks + manifest.
  copyFiles(["src-admin/build/customComponents.js"], "admin/custom");
  copyFiles(["src-admin/build/mf-manifest.json"], "admin/custom");
  copyFiles(["src-admin/build/assets/*"], "admin/custom/assets");
  copyFiles(["src-admin/src/i18n/*.json"], "admin/custom/i18n");
}

if (process.argv.includes("--0-clean")) {
  clean();
} else if (process.argv.includes("--1-npm")) {
  npmInstall(src).catch(e => console.error(`Cannot install npm: ${e}`));
} else if (process.argv.includes("--2-build")) {
  buildReact(src, { vite: true }).catch(e => console.error(`Cannot build: ${e}`));
} else if (process.argv.includes("--3-copy")) {
  copyAllFiles();
} else {
  clean();
  npmInstall(src)
    .then(() => buildReact(src, { vite: true }))
    .then(() => copyAllFiles())
    .catch(e => {
      console.error(e);
      process.exit(2);
    });
}

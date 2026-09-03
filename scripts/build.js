const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const copyRecursive = (source, destination) => {
  if (!fs.existsSync(source)) {
    return;
  }

  const stat = fs.statSync(source);

  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

copyRecursive(path.join(rootDir, 'src'), path.join(distDir, 'src'));
copyRecursive(path.join(rootDir, 'public'), path.join(distDir, 'public'));
copyRecursive(path.join(rootDir, 'index.js'), path.join(distDir, 'index.js'));

const entryPoint = path.join(distDir, 'index.js');
if (!fs.existsSync(entryPoint)) {
  throw new Error('Backend build failed: dist/index.js was not created.');
}

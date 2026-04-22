const { Jimp } = require("jimp");
const pngToIco = require("png-to-ico");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "assets");
const SRC = path.join(ASSETS, "icon-source.jpg");

async function main() {
  const img = await Jimp.read(SRC);

  // Write individual PNGs for each size, then feed paths to png-to-ico
  const sizes = [16, 32, 48, 256];
  const tmpPaths = [];

  for (const s of sizes) {
    const p = path.join(ASSETS, `icon-tmp-${s}.png`);
    await img.clone().resize({ w: s, h: s }).write(p);
    tmpPaths.push(p);
  }

  // 32x32 PNG for tray (already written as icon-tmp-32.png, copy it)
  fs.copyFileSync(path.join(ASSETS, "icon-tmp-32.png"), path.join(ASSETS, "icon-tray.png"));
  console.log("✓ icon-tray.png (32x32)");

  // Build multi-size ICO from file paths
  const icoBuffer = await pngToIco.default(tmpPaths);
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), icoBuffer);
  console.log("✓ icon.ico (16/32/48/256)");

  // Clean up temp files
  for (const p of tmpPaths) fs.unlinkSync(p);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

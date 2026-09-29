// 把估值面板、低点信号的数据传到云存储。代码不用重传，小程序下次打开就读到新数据。
// 用法：node tools/upload_data.js [--old]  （会先把公开站仓库的本地克隆拉到最新、跑 build_val.py；--old 连旧版单页数据一起传）
// 环境 ID 读 miniprogram/config.js 的 ENV；密钥同 upload.js。
// 公开仓库的每日任务也跑这个脚本（deploy.sh 拷到那边的 tools/mp/），那边没有 config.js 和本机密钥，
// 用环境变量传：MP_ENV（环境 ID）、MP_KEY_FILE（密钥文件，从 GitHub 加密机密里写出来的）、MP_DATA_OUT（数据目录）。
const ci = require(process.env.MPCI || "/home/d/260917_jack_playground/mindyoga/tools/node_modules/miniprogram-ci");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APPID = "wx5df03816d05ed7b1";
const ENV = process.env.MP_ENV || require("../miniprogram/config.js").ENV;
const KEY = process.env.MP_KEY_FILE || path.join(os.homedir(), ".sp500-keys", `private.${APPID}.key`);
const DATA = process.env.MP_DATA_OUT || path.join(__dirname, "..", "cloud_data");
if (!ENV) { console.error("先在 miniprogram/config.js 里填 ENV（云开发环境 ID）"); process.exit(1); }
// 本机手动跑（没给 MP_DATA_OUT）时两处保护（2026-09-28 检查 #12/32）：
//  1. 先把公开仓库的本地克隆拉到最新：克隆停在几天前时，会用旧的估值、信号数据盖掉每日任务刚传上去的新数据；
//  2. 旧版单页数据 old/ 默认不传：它由每日任务重算上传，本机的 site/data.json 常常停在几天前。确实要传加 --old。
const LOCAL = !process.env.MP_DATA_OUT;
if (LOCAL) {
  const repo = process.env.DEPLOY_REPO || path.join(os.homedir(), ".cache", "sp500-viewer-deploy");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8" }).trim();
  git("fetch", "-q", "origin", "main");
  if (git("status", "--porcelain") || git("rev-list", "origin/main..HEAD")) {
    console.error(`${repo} 有没提交或没推送的改动，先处理（deploy.sh 推上去）再传，免得丢改动`); process.exit(1);
  }
  git("reset", "-q", "--hard", "origin/main");
  console.log("公开仓库克隆已到最新：" + git("log", "-1", "--format=%h %ci %s"));
}
execFileSync("python3", [path.join(__dirname, "build_val.py")], { stdio: "inherit" });
let SRC_DIR = DATA;
if (LOCAL && process.argv.indexOf("--old") < 0) {
  SRC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mpdata-"));
  fs.cpSync(DATA, SRC_DIR, { recursive: true, filter: f => path.relative(DATA, f).split(path.sep)[0] !== "old" });
  console.log("旧版单页数据 old/ 不传（每日任务在传）；确实要传加 --old");
}

const project = new ci.Project({
  appid: APPID, type: "miniProgram", projectPath: path.join(__dirname, ".."), privateKeyPath: KEY, ignores: ["node_modules/**/*"]
});
// 整个数据目录照原样传：val/ 是估值面板，sig/ 是低点信号，lab/ 是研究页、标注低点和 Dexter 支撑位
ci.cloud.uploadStorage({ project, env: ENV, path: SRC_DIR, remotePath: "", concurrency: 8 })
  .then(() => console.log(`已传到云存储 ${ENV}:/（val/ 估值、sig/ 信号、lab/ 研究页与 Dexter${SRC_DIR === DATA ? "、old/ 旧版单页" : ""}）`))
  .catch(e => { console.error("上传失败：", e.message || e); process.exit(1); });

# Halloween Check-in

把去过的地方，收藏成会随天色亮灯的微缩小楼。说一句 `checkin`，再加一句 `Halloween`，它还会换上一套万圣节装扮。

在线演示：https://halloween-checkin.a512884335.workers.dev （目前只有一条用代码画的合成演示记录）

参加 AWS「Kiro 鬼点子计划」线上赛。

## 怎么用

在支持生图的 AI 对话里（ChatGPT、Codex 等）上传一张你拍的地点照片，说：

```
checkin Halloween
```

Skill 会：

1. 用照片生成白天的微缩模型，再只用这张白天图生成同一栋楼的夜景；
2. 抠掉背景、统一构图，输出两张 720×720 透明 PNG，并做自动校验；
3. 把确切的两张图、文案、差异说明（比如"加了一个南瓜"）给你审核，然后**停下**；
4. 你明确说"发布"之后，才发布到网站。

网站上：左下角切换白天/夜晚（同时切换夜景图），中间切换普通版/万圣节版，右下角的 🎃 打开万圣节氛围（蝙蝠、雾、火星，纯装饰）。点图片或"All places"看全部地点，←/→ 或左右滑动换一个地方。

## 架构

```
宿主 AI（Skill）                    Cloudflare Worker                     网站
照片 + checkin [Halloween]           POST /api/revisions   注册版本         GET /api/checkins
→ 宿主生图（你的订阅）              PUT  …/media/day|night 上传确切字节     GET /media/<rev>/<day|night>.png
→ npm run prepare:images            POST …/approve        绑定哈希与目标   （只返回已发布的安全字段）
→ npm run hc -- review / submit     POST …/publish        幂等发布
→ 审核，等你说发布                   D1：记录/版本/批准/操作   R2：不可变图片
```

- 生图只发生在宿主里，网站和后端不调用任何生图服务。
- 批准绑定版本、内容哈希和发布目标，30 分钟过期，可撤销；任何改动都会产生新版本，旧批准失效。
- 发布是幂等的：同一个幂等键重放返回同一结果，同键不同内容报冲突；一个版本最多发布一次。
- 先写图片、再一次原子提交记录；提交结果不确定时，用同一个键恢复，不会重复发布。
- 普通版和万圣节版分开存，互不覆盖。地点、拍摄时间、同行者可以为空，空就是空：拍摄时间未知时，网站写"Added … · 3 days ago"，并注明那是发布时间，而不是"Spotted at"。

## 动效

- 入场：模型带弹簧落下，说明文字逐段浮现。
- 悬停：模型随指针做 3D 倾斜，表面高光只落在建筑轮廓上（用图片本身做遮罩），离开时弹回。
- 白天/夜晚：从按钮位置圆形扩散切换（View Transitions），夜景窗户带暖光。
- 普通/万圣节：模型像硬纸板立牌一样翻转后换装。
- 全部地点：大图飞入网格中对应的位置，返回时再飞回来；网格依次浮现。
- 万圣节氛围：蝙蝠沿随机路线扇翅飞过、雾气漂移、火星上升、建筑下方烛光闪烁。
- 系统开启"减少动态效果"时全部关闭。

## 运行

需要 Node ≥ 22.12。

```bash
npm ci
npm run verify       # 全部测试 + 构建
npm run e2e:local    # 在本地 workerd 里跑完整链路（本地模拟 D1/R2，不连 Cloudflare，合成素材）
npm run dev          # 只看页面（没有后端时显示加载失败）
```

发布一条（需要后端地址和所有者令牌，令牌只放环境变量）：

```bash
export HC_API_URL=https://…  HC_TOKEN=…
npm run prepare:images -- --day raw-day.png --night raw-night.png --out-dir prep
npm run hc -- review --day prep/day.png --night prep/night.png --theme halloween --text "at …" --out ws
npm run hc -- submit  --dir ws      # 注册并上传；此时什么都没公开
npm run hc -- approve --dir ws      # 只在你明确要求发布之后
npm run hc -- publish --dir ws      # 发布，并核验公开图片的状态、类型和字节哈希
```

部署记录与步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 测试

`npm test` 覆盖：规范化哈希与输入校验、状态机、批准（缺失、过期、撤销、错目标）、发布（重复、并发、同键异内容、提交前失败、提交后响应丢失、第二张图上传失败、批次回滚）、权限（匿名、错令牌、他人草稿）、隐私（公开接口无私密字段，未发布图片不可访问）、PNG 结构检查（签名、CRC、截断、尾随数据、未知关键块、解压炸弹）、图片准备（多种背景色、自带透明、内部同色细节保留、去碎点、共享构图、拒绝杂乱背景）、网站显示逻辑与弹簧、页面脚本只读不写、Skill 与命令一致性、Cloudflare 远程操作守卫。

数据库测试用 `node:sqlite` 替身，对象存储用内存替身；`npm run e2e:local` 在真实的 Workers 运行时里跑。并发只在单进程内测试，生产环境的竞争没有压测。

## 现状与限制（如实）

- Skill 还没在真实宿主里配真实照片跑过；提示词和图片准备只用合成素材验证过，第一次真实出图可能需要调整。
- 认证只有 Bearer 令牌，没有 OAuth/MCP，所以没有 ChatGPT 远程连接器。
- 批准是代理声明（见上），没有网页确认按钮。
- 没有速率限制，没有替换、回滚或删除功能。
- 视觉检查（招牌、结构、夜景是不是同一栋楼）由代理和你完成，脚本只做机械检查。
- 页面在浏览器中做过可视检查，没有做自动化浏览器测试或读屏器测试。

## Kiro 开发记录

- `.kiro/specs/halloween-checkin/`：需求、设计、任务。需求与设计初稿来自设计交接包；实现决策和任务勾选在 Kiro 中按实际完成情况更新。
- `.kiro/steering/project.md`：项目约束。
- `.kiro/hooks/`：执行 wrangler 远程/破坏性操作前要求确认（`scripts/guard-cloudflare.mjs`）；保存源码时跑测试。
- 本仓库的代码、测试、Skill 文案和提示词在 Kiro 中编写。更早的开发过程保存在作者的私有开发仓库里。
- 生图不是 Kiro 的能力：真实流程里的图片由宿主 AI 生成。

## 致谢与来源

- "主页上一句话告诉你我最近在哪里，配一张那个地方的小图"这个想法，来自设计师 [Peng Zheng 的个人主页](https://www.pengzhe.ng/)，也来自作者早先受它启发做的 August Check-in。本仓库的代码、样式、文案、提示词和素材都是为本项目重新编写的，没有复制它们。
- 依赖：[Astro](https://astro.build)、[sharp](https://sharp.pixelplumbing.com)、[Wrangler](https://developers.cloudflare.com/workers/wrangler/)。
- 演示素材是代码画的合成小房子，不对应真实地点。

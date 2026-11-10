**提示词（原样）：**

```text
用 Vite 建一个单页网页应用，名字叫「Potency Ranker」（效力排序器）：用户上传一份剂量–反应 CSV，
app 在浏览器里用真正的 R（webR）对每一个化合物分别拟合四参数逻辑斯蒂（4PL）曲线，给出 IC50
及其 95% 置信区间、Hill 斜率、top、bottom，画出横轴为 log 浓度的剂量–反应图，并按效力从强到弱排序。

【环境与约束】
- 纯前端：Vite + 原生 JavaScript。不要 React，不要 TypeScript，不要后端，不要任何服务器端代码，
  不要调用外部 API，不要数据库。
- R 通过 npm 包 webr（旧名 @r-wasm/webr）在浏览器里运行。只用 base R 和自带的 stats（nls、confint）。
  不要加载任何其他 R 包——webR 装不上。
- 如果目录非空导致 npm create vite 交互卡住，就手工创建 package.json、index.html、vite.config.js、
  src/main.js。
- 依赖只有 vite 和 webr。开发服务器跑在 5173 端口，命令是 npm run dev。
- 如果你不确定当前 webR 的 JavaScript API，请先去 node_modules/webr 或官方文档确认再写代码，
  不要凭记忆编函数名。
- 界面文案用中文；代码注释可以用英文。

【数据 DATA】
页面提供一个文件选择框，读取 CSV（UTF-8，逗号分隔），列名必须完全一致：
    compound, conc_nM, response_pct, replicate
示例：
    compound,conc_nM,response_pct,replicate
    A,0.3,4.1,1
    A,3,6.2,1
    A,30,49.3,1
    A,1000,98.4,1
读入后立刻显示一块「数据自检」信息：总行数、化合物个数、每个化合物的浓度点位数与重复数、
实测浓度范围（最小–最大 nM）、以及因缺失值被跳过的行数。绝对不允许静默丢弃数据行。
把数据以 CSV 文本形式传进 R（read.csv(text = ...)），避免复杂的数据搬运。

【方法 METHOD】
- 每个化合物单独拟合，绝不把不同化合物合并成一条曲线。
- 模型：response = bottom + (top - bottom) / (1 + 10^((logIC50 - log10(conc)) * hill))，用 nls() 拟合；
  自变量一律用 log10(conc)。绝不使用原始线性浓度。
- 初值：bottom = min(response)，top = max(response)，logIC50 = median(log10(conc))，hill = 1。
- 置信区间：confint(fit, "logIC50", level = 0.95)（profile likelihood），再用 10^ 变换回 nM——
  注意变换后区间左右不对称，两个端点都要保留。
- 同时报告 top、bottom、hill 和残差标准误；如果残差偏大，要在表里明说，不要只印一个好看的 R²。
- nls() 报错或不收敛时页面不能崩：显示「拟合失败」并给出原因。

【输出 OUTPUT】单页两块：
1）上方「Data」区：标题 Potency Ranker、一行副标题、文件选择框、数据自检面板、「Run fit」按钮。
   在还没上传数据时，这一屏必须看起来已经是个完整的工具（控件齐全 + 空状态提示），不能一片空白。
2）下方「Results」区：参数表（化合物、IC50 nM、95% CI 下限、95% CI 上限、Hill、top、bottom、
   数据点数、状态）+ 图（x 轴 log10 刻度并标注 nM，画出全部原始重复散点 + 拟合曲线 + IC50 处竖虚线；
   不许用柱状图，不许截断坐标轴）+ 一个「R code」面板，原样打印这次实际执行过的 R 代码。
- 再加一个「导出结果 CSV」按钮。

先说明是否能看懂，并且说明是否缺少环境。
```

**AI 做了什么。** 复述了需求，检查了工作目录和工具链，并先从已安装的包和官方文档确认 webR 0.6.1 的 JavaScript 接口，而不是凭记忆编函数名。

**我的后续。** 要求它在写任何代码之前，先明确说明构建环境是否缺东西。


**提示词（原样）：**

```text
那开始吧
```

**AI 做了什么。** 手工创建 Vite 项目（没有用交互式脚手架），只安装 vite 和 webr，把 webR 运行时自托管到 public/webr/，然后完成 CSV 解析与数据自检、R 程序生成、SVG 剂量–反应图、结果表、R code 面板和 CSV 导出，最后在无头 Chrome 里把整个流程跑通。

搭建过程中遇到并修掉了三个真问题：

- 第一次提取置信区间就崩溃：confint(fit, "logIC50", …) 返回的是向量而不是矩阵；
- 普通高斯–牛顿法的 nls() 在一条很干净的曲线上报「singular gradient」（奇异梯度），另外还有两个化合物的 profile 置信区间失败，于是拟合改为 algorithm = "port" 并配很宽的边界；
- 一行 5 KB 的 URL 编码数据把结果区格子撑宽、图表被放大，用 min-width: 0 修好。

**我的后续。** 我没有只看演示效果，而是做了一轮验收检查。


**提示词（原样）：**

```text
需要检查：
- 「R code」面板必须显示真正用于拟合和取置信区间的 R 代码，不是摘要。
- 解析出的行数与文件实际行数不一致时，要显式警告。
- 绝对不要硬编码化合物名或数值：A/B/C 必须来自上传的文件。

完成后告诉我：新建了哪些文件、怎么安装和启动、页面上应该看到什么。
```

**AI 做了什么。** 新增 src/consistency.js 和行数核对条：把文件行数、页面解析行数、R 实际使用行数和化合物列表逐项比对，一致时显示绿色，不一致时显示红色警告。又在浏览器测试里加了断言，确认 R code 面板包含完整的 4PL 公式、confint(fit, "logIC50", level = 0.95) 和 URL 编码后的 CSV，避免面板以后悄悄变成摘要。最后用 grep 搜索，并换一份化合物完全不同的数据重跑，确认没有任何化合物名或数值被硬编码。

**交付。** 修好的程序、新建文件清单、安装和启动命令、页面上应看到的内容。

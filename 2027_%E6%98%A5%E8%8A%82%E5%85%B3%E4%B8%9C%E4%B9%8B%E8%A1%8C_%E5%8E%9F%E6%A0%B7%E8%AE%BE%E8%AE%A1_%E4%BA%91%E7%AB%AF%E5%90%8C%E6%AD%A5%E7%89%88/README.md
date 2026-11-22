# 春节关东之行 — 与用户上传的 HTML 完全相同的页面设计

本包 public/index.html 的内容与用户提供的 japan_trip_preview_v2(1).html 完全相同，富士山照片嵌入 HTML 内，无需额外图片文件。

## 带云端同步功能的 Netlify 部署步骤
1. 解压本包并将根目录内容上传到 GitHub 仓库，确保仓库根目录直接包含 public、netlify、netlify.toml 和 package.json。
2. 在 Netlify 打开**现有网站项目**（不要重新创建一个站点）；在 Project configuration 里将仓库关联为该网站的部署源。若原站已连 GitHub，就把本包更新到它的现有仓库即可。
3. 在 Environment variables 里添加 TRIP_ADMIN_PASSWORD，设一个独立的强密码；变量需要用于生产部署中的 Functions。
4. 确认构建设置：base directory 为空，publish directory 是 public，functions directory 是 netlify/functions，通常无 build command。netlify.toml 已包含这些配置。部署/重新部署。
5. 打开 https://你的网址/api/trip ：应返回 JSON。首次数据为空是正常的。
6. 打开网站，输入管理员密码进入编辑；新增一条测试行程并保存，确认看到“已同步到云端”，再用无痕浏览器刷新检查是否同步。

## 重要提醒
- 不要只将本包拖拽到 Netlify Drop：那样可能只有静态网站而无 Netlify Function。需要 GitHub 集成部署或使用 Netlify CLI 从项目根目录部署。
- 此项目中 `/api/trip` GET 对所有访问者公开，只保护编辑接口；不要填写护照号、完整预订号、付款数据等敏感信息。
- 若已有在线编辑数据，尽量保留**同一个 Netlify 站点**；不要把仓库部署到另一个新站点，否则 Netlify Blobs 数据互不共享。
- 网站在中国大陆或微信中的访问情况需用家人的手机实际测试。

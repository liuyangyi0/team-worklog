# Team Worklog · 工作完成记录

一个轻量的团队工作记录与项目协作工具，记录“原定谁负责、实际谁完成”，支持公开浏览、多人维护和不可删除的操作日志。

当前版本：**1.6.0**。前端采用 React、Vite、Tailwind CSS 和 lucide-react；后端使用 Node.js 24 自带的 HTTP 与 SQLite，无需单独部署数据库。

## 功能

- 多项目、项目配色、常用成员、原定负责人和实际完成人多选。
- 子任务、评论、跨项目人员总览、按人汇总及公开操作日志。
- 计划完成日期、优先级、临期/逾期提示、个人待办与站内提醒。
- 跨项目任务依赖、循环依赖校验、自动/手动阻塞、配合人员和“需要我配合”。
- 搜索、筛选、排序、分页、截图模式、PNG 图片与 JSON 导出。
- 多人编辑版本冲突保护、删除撤销、SQLite 持久化与定时备份示例。

完成规则：实际完成人或完成日期任填一项即完成；两项都空为未完成。计划日期、阻塞标记和配合人员不会改变完成状态。统计只计叶子任务，避免父子重复计数；共同完成在每位实际完成人名下各计一项。

## 快速运行

需要 Node.js **24.19 或更新的 24.x**。

~~~sh
git clone https://github.com/liuyangyi0/team-worklog.git
cd team-worklog
npm ci
npm test
npm run build
npm start
~~~

打开 [http://127.0.0.1:8766/worklog/](http://127.0.0.1:8766/worklog/)。所有人可浏览，注册登录后可维护内容。

公开版使用虚构的示例项目和注册名单。例如，可用“韩示例二”或“胡示例三”作为姓名注册，账号和密码自行设置。正式使用时请先修改 [registration.mjs](registration.mjs) 中的名单；未命中名单会提示“请填写真实姓名”。原有线上部署及其真实名单不在此仓库中。

开发前端运行 `npm run dev`。后端也需要运行，并把 `APP_ORIGIN` 设置为实际前端地址，例如 `http://127.0.0.1:5173`。

## 配置

通过进程环境变量配置，程序不会自动加载 .env 文件。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| HOST | 127.0.0.1 | 后端监听地址 |
| PORT | 8766 | 后端端口 |
| DATA_DIR | data | 数据库及备份的数据目录 |
| APP_ORIGIN | http://127.0.0.1:8766 | 浏览器访问来源，包含协议和端口 |
| ADMIN_PASSWORD | 未设置 | 首次运行时创建管理员账号，可选；密码至少 8 位 |

管理员不是内容编辑的唯一入口；所有注册成员都能维护全部项目和记录。账号密码由本人修改；任务、评论、项目等内容变更保留公开日志，日志不可通过页面或接口改删。

## 部署与备份

1. 在部署目录运行 `npm ci` 和 `npm run build`。
2. 配置实际的 `APP_ORIGIN` 与独立的 `DATA_DIR`，修改注册名单。
3. 使用 `npm start`，或按 [worklog.service](worklog.service) 中的 systemd 示例部署。
4. 如使用 Nginx，可参考 [nginx-location.conf](nginx-location.conf)，应用路径为 `/worklog/`。
5. 数据保存在 `DATA_DIR/worklog.sqlite`，备份使用 `backup.mjs`；systemd 定时备份示例默认在北京时间每天 03:15 执行。

服务文件中的 `/srv/worklog`、`/usr/bin/node` 和 `https://worklog.example.com` 都是示例路径/域名，请按自己的环境调整。

`deploy.sh` 只安装本项目的 systemd 服务与备份定时器，不会自动改写 Nginx 配置。更新应用时保留数据目录；服务启动会兼容迁移现有数据库。

## 测试

~~~sh
npm test
npm run build
~~~

另有四组浏览器回归，覆盖记录编辑、子任务/评论、待办/提醒以及任务依赖，均使用临时数据库，不连接生产服务。准备 Playwright 和 Chromium 后运行：

~~~sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
~~~

可通过 `PLAYWRIGHT_MODULE_PATH`、`PLAYWRIGHT_EXECUTABLE_PATH` 指定已有的工具与浏览器。

## 文档

- [使用说明](使用说明.md)
- [界面设计说明](设计说明.md)

仓库包含源码、测试和部署示例；不包含真实成员名单、数据库、登录凭据、生产部署信息或本地备份。

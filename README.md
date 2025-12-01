# Node.js 复现 note.ms

基于 [pereorga/minimalist-web-notepad](https://github.com/pereorga/minimalist-web-notepad) 项目的 Node.js 实现，新增密码保护功能，提供极简风格的网页记事本服务。

## 功能特点

- 🛡️ **密码保护**：采用 `pbkdf2` 加密算法（10000 轮次迭代 + sha512 哈希），确保笔记内容安全
- ✅�🎯 **极简设计**：专注于笔记内容，去除冗余功能，保持界面简洁
- 🚀 **轻量高效**：基于 Node.js + Express 构建，启动快速，资源占用低
- 🔗 **URL 直达**：通过 `/notes/<random-string>` 直接访问或创建笔记
- 💾 **自动保存**：实时保存内容，避免意外丢失
- 📋 **灵活部署**：支持本地部署，无需复杂配置



## 在线试用

[https://www.hanphone.top/notes/](https://www.hanphone.top/notes/)

## 本地部署

### 环境要求

- 🟢 Node.js 18.x 及以上版本（兼容最新 LTS 版本）
- 📦 npm 或 yarn 包管理器

### 安装步骤

```shell
# 克隆仓库
git clone <仓库地址>
cd notes

# 安装依赖
npm install

# 启动服务
node server.js
```

服务启动后，访问 `http://localhost:3000` 即可使用（默认端口可通过配置修改）

## 使用方法

1. **创建笔记**：访问 `/notes/自定义笔记名` 即可创建新笔记
2. **设置密码**：首次编辑后可设置密码，加密算法采用行业标准的 pbkdf2
3. **访问加密笔记**：输入正确密码后即可查看和编辑，密码验证通过后方可操作
4. **命名规则**：仅支持字母、数字、下划线和短横线，长度不超过 64 字符

## 技术栈

![Node.js](https://img.shields.io/badge/node.js-18.x+-blue.svg)![Express](https://img.shields.io/badge/express-5.1.0-lightgrey.svg)     

- 🔙 后端：Node.js + Express 5.1.0
- 🗄️ 存储：基于文件系统（轻量无数据库依赖）
- 🔒 加密：Node.js 内置 crypto 模块（pbkdf2 算法）
- 🎨 前端：极简 HTML/CSS/JavaScript（继承自原项目）

## 许可证

![MIT License](https://img.shields.io/badge/license-MIT-green.svg)


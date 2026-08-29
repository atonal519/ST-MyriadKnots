# Myriad Knots（千千结）

`ST-MyriadKnots` 是 SillyTavern 的关系档案扩展，界面中文名为“千千结”。入口会读取当前单人聊天、角色头像定位和 Persona 定位，在 `qianqianjie` 聊天元数据中保存 UUID，并通过 ST-BaiNiaoData V1 records/revision API 创建或恢复正式档案。

项目仓库：[github.com/atonal519/ST-MyriadKnots](https://github.com/atonal519/ST-MyriadKnots)

## 安装

在 SillyTavern 的第三方扩展安装入口中，粘贴上述仓库 URL 并安装；安装完成后按提示重新加载扩展即可。

设置入口位于魔法棒菜单和主面板右下角。人物识别可自动继承构画的机械预设／主 API，也可使用千千结自己的命名预设，或明确回退酒馆当前模型。继承构画时只在请求瞬间读取配置，不复制构画密钥。

总开关关闭后不会读取聊天、扫描来源、调用 AI 或写入后端；已有档案保持原样，魔法棒设置入口仍可用于重新开启。

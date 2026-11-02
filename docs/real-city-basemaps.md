# 现实地图静态素材

七城主要建成区分文件保存于 `assets/maps-real/`，`catalog.json` 记录覆盖范围、WGS84投影、来源和SHA256。离线审阅页为 [real-city-basemaps.html](../mockups/real-city-basemaps.html)。城市地图页沿当前地点树展示；其它城市、城镇和独立地域按题材使用[通用素材库](qianchuang-assets.md)，现有18张。

| 地图 | 层级 | 文件 | KiB | gzip KiB |
|---|---|---|---:|---:|
| 首尔 | 城市实图 | seoul.svg | 751.3 | 279.6 |
| 北京 | 城市实图 | beijing.svg | 632.7 | 230.8 |
| 上海 | 城市实图 | shanghai.svg | 1006.2 | 367.6 |
| 广州 | 城市实图 | guangzhou.svg | 875.5 | 321.6 |
| 东京 | 城市实图 | tokyo.svg | 723.6 | 267.5 |
| 纽约 | 城市实图 | new-york.svg | 1435.1 | 528.6 |
| 洛杉矶 | 城市实图 | los-angeles.svg | 2561.3 | 812.9 |


城市道路、水面与部分公园来自OpenStreetMap公开数据；海岸陆地掩膜来自Natural Earth 1:10 million land。此处10m表示比例尺1:10,000,000。道路按主干、主要与次要道路分层；首尔另含三级路与公园。水面按原闭合way及multipolygon成员拼接，保有效外环与可见孔洞。离线仅简化不可见精度：道路0.65 SVG像素、水面0.3，输出一位小数；小于3平方SVG像素的面和1.5平方像素的孔洞省略。

无法由所取成员形成有效外环/孔洞的少量水面关系按完整relation省略，ID和原因在各城stats.excludedInvalidRelations记录。原采集正文、query、响应状态、时间及hash保在本轮私有构建证据中；合并分层数据按OSM type/id去重，成功数据必须非空且无Overpass remark。

## 城市页与示意点

千窗按城市或独立地图范围分页，独立地域、巨舰、星球可分别浏览。已有七城采用真实背景，其他城市和架空地点用合适的通用底图；每页保存自己的环境选择。国家节点保留原UUID和父边，在普通地图、列表与导航隐藏，编辑所属地点仍显示完整路径，不提供国家总览。人工地图层级可选普通地点、城市、国家、独立地图，人工普通地点优先。未归属地点仅进入折叠目录，不创建额外地图页。

城内地点与淡地区名沿离线陆地近路落点示意，不画随机行政区边界。素材中的Mercator参数仅记录生成来源，不参与本次运行时定位；无经纬度UI、地理查询或额外模型请求。每份SVG按所选城市从本地读取，未加入主bundle。预览只在城市页间切换，署名为普通文字。

## 来源与许可

- OpenStreetMap：© OpenStreetMap contributors，数据[版权与ODbL说明](https://www.openstreetmap.org/copyright)，[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。通过公开Overpass离线取指定bbox，未取OSM瓦片。采集实例为[overpass-api.de](https://overpass-api.de/)；失败的备用公开实例与完整尝试记录保在构建证据。各城原raw/分层raw SHA256见catalog。
- Natural Earth，[公共领域使用条款](https://www.naturalearthdata.com/about/terms-of-use/)。[1:10m land](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/)、[populated places](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/)。原ZIP哈希与城市中心来源另存catalog。
- 固定版D3仅用于私有离线生成，未加入运行时依赖。成品SVG不含脚本、外部字体、远程图层或地理服务调用。审阅页署名为普通文字，许可链接集中在本文档。

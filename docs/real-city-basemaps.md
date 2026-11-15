# 现实地图静态素材

十个真实城市的已收录片区分文件保存于 `assets/maps-real/`，`catalog.json` 记录覆盖范围、WGS84经纬度、Mercator投影参数、来源和SHA256。离线审阅页为 [real-city-basemaps.html](../mockups/real-city-basemaps.html)。城市地图页沿当前地点树展示；其它城市、城镇和独立地域按题材使用[通用素材库](qianchuang-assets.md)，现有24张。

| 地图 | 层级 | 文件 | KiB | gzip KiB |
| --- | --- | --- | ---: | ---: |
| 首尔 | 城市实图 | seoul.svg | 751.4 | 279.7 |
| 北京 | 城市实图 | beijing.svg | 632.8 | 230.9 |
| 上海 | 城市实图 | shanghai.svg | 1006.3 | 367.6 |
| 广州 | 城市实图 | guangzhou.svg | 875.6 | 321.6 |
| 东京 | 城市实图 | tokyo.svg | 723.7 | 267.5 |
| 纽约 | 城市实图 | new-york.svg | 1435.1 | 528.6 |
| 洛杉矶 | 城市实图 | los-angeles.svg | 2561.4 | 812.9 |
| 重庆 | 城市实图 | chongqing.svg | 346.7 | 133.9 |
| 香港 | 城市实图 | hong-kong.svg | 918.6 | 327.0 |
| 名古屋 | 城市实图 | nagoya.svg | 306.4 | 114.4 |


城市道路、水面与部分公园来自OpenStreetMap公开数据；海岸陆地掩膜来自Natural Earth 1:10 million land。此处10m表示比例尺1:10,000,000。道路按主干、主要与次要道路分层；首尔另含三级路与公园。水面按原闭合way及multipolygon成员拼接，保有效外环与可见孔洞。离线仅简化不可见精度：道路0.65 SVG像素、水面0.3，输出一位小数；小于3平方SVG像素的面和1.5平方像素的孔洞省略。

无法由所取成员形成有效外环/孔洞的少量水面关系按完整relation省略，ID和原因在各城stats.excludedInvalidRelations记录。已记录的来源、范围、采集与产出哈希见[城市目录](../assets/maps-real/catalog.json)；合并分层数据按OSM type/id去重，成功数据必须非空且无Overpass remark。

## 城市页与示意点

千窗按城市或独立地图范围分页，独立地域、巨舰、星球可分别浏览。已收录十城采用真实背景，其他城市和架空地点用合适的通用底图；每页保存自己的环境选择。国家节点保留原UUID和父边，在普通地图、列表与导航隐藏，编辑所属地点仍显示完整路径，不提供国家总览。人工地图层级可选普通地点、城市、国家、独立地图，人工普通地点优先。未归属地点仅进入折叠目录，不创建额外地图页。

城内地点与淡地区名沿离线陆地近路落点示意，不画随机行政区边界。素材中的Mercator参数仅记录生成来源，不参与本次运行时定位；无经纬度UI、地理查询或额外模型请求。每份SVG按所选城市从本地读取，未加入主bundle。预览只在城市页间切换，署名为普通文字。

## 来源与许可

- OpenStreetMap：© OpenStreetMap contributors，数据[版权与ODbL说明](https://www.openstreetmap.org/copyright)，[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。通过公开Overpass离线取指定bbox，未取OSM瓦片。采集实例为[overpass-api.de](https://overpass-api.de/)；各城已记录的原raw/分层raw SHA256见catalog。
- Natural Earth，[公共领域使用条款](https://www.naturalearthdata.com/about/terms-of-use/)。[1:10m land](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/)、[populated places](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/)。原ZIP哈希与城市中心来源另存catalog。
- 固定版D3仅用于私有离线生成，未加入运行时依赖。成品SVG不含脚本、外部字体、远程图层或地理服务调用。审阅页署名为普通文字，许可链接集中在本文档。

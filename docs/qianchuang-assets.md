# 千窗静态底图

千窗在固定背景上显示当前聊天中有明确包含关系的场地，点位为界面示意排布，不表示真实坐标或距离。素材使用静态SVG几何，默认从免费静态图库读取目录和图片，已有图同时保留在插件内供读取失败时使用。SVG不含生成器、外部字体、脚本或在线地图图层。

- **大城市**：OpenStreetMap 钟路街区数据，范围126.982,37.565–126.993,37.575，经投影、裁切和主题配色处理。© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。显示此底图时保留普通文字署名“© OpenStreetMap contributors · ODbL”，完整版权与许可链接保留于本文档。原始采集SHA256：26114c040bfc0034743f247ad28ef007eec8e8b60c5127492f6e59d05c67e462。
- **城镇与宫苑**：按真实城镇和设施片区绘制，来源包括Siena旧城、Lucca、Lemgo、Vltava河湾、Vannes港城、景福宫及Versailles宫苑。道路、建筑、水面和绿地使用OpenStreetMap公开几何，按[ODbL 1.0](https://www.openstreetmap.org/copyright)署名。
- **旧保存值**：`modern/town/palace/modern-town/old-town/sci-fi`继续保留原保存字符串，读取时分别承接`modern-inland/old-town-inland/palace-axial/modern-town-plain/old-town-plain/sci-fi-linear`；沿现有图库按需载入，无设置迁移或主页选择控件。旧兼容模块中的早期Watabou Redfall几何仍按[官方FAQ](https://watabou.github.io/faq.html)输出许可保留。

界面沿用插件已有控件和几何点标记；地点及设施可使用完整 Lucide v1.17.0 图库，共1958个名称（含别名）、1712份独立几何。`src/ui/qianchuang-lucide-data.js` 保存可信静态节点，随本地构建载入，只将实际取用的图标渲染为SVG；名称支持原库PascalCase、kebab-case和空格形式，保留原九个调用别名。无远程取图、宿主全局库或生成器依赖。路径依据官方已构建版本，遵守 ISC；完整官方许可见 [lucide-license.txt](lucide-license.txt)。`src/ui/qianchuang-basemaps.js` 保留旧静态几何兼容，不包含原型示例地点、描述或点位。正式素材由 `src/qianchuang-map-assets.js` 登记；页面不设手动底图选择，优先保留既有人工保存值，其余按各地图页的环境提示选择，缺少提示时使用既有默认。

设施优先显示原摘要或整理同次返回的`facilities:[{icon,label}]`，沿现有地点展示事实及其原source保存；显式空数组表示该处已经筛读且无设施。整理会提供完整图标名称和本地常用词索引，SVG路径保留在本地；普通摘要只收可选提示，不发送整库。手改描述当次清除该地点旧提示，再次整理可按最新人工描述重新选择。没有模型提示的旧描述沿用本地匹配：完整原库名称参与英文名称匹配，中文家居、厨卫家电、影音运动、安保医疗、交通及室外设施使用常用词表；原库没有中文标签或分类数据。鞋柜使用原库SportShoe作鞋类示意，地毯使用RectangleHorizontal作形状示意。主描述中的否定优先于旧补充，人工清空不从补充恢复。原文完整保留；相同显示文字规范空白后去重，语义相似的实体和描述仍分别展示。

地点层级与描述共用当前地点索引及人工修订。相关世界书材料沿既有权限并入原摘要请求，或由用户显式“整理”一次；完整路径由本地补中间节点并复用已有 UUID。自动区只更新本次返回的地点字段，人工字段最后覆盖。页面不独立读取世界书补另一套描述，不执行原书宏脚本，也不追踪实时书版本。

地点简介与方位由原同一次摘要或整理更新：只在有据变化时合并为完整当前内容，已有重复与同义说法可在整理时收束；修改一处设施保留其他未变内容。旧FloorMemory和原引文保留，完整简介更新另存当时快照供历史与召回使用；当前目录通过具体已读事实ID覆盖旧显示项，不覆盖未读或后来新增事实。人工描述、方位及空值保持优先。

显式整理可在尚无摘要时进行，使用当前目录与人工字段、已保存地点引文、允许世界书及角色description/scenario；角色字段使用独立characterCard来源。不发送近期全文或整聊，不增加模型调用。已选聊天没有Core时，整理沿原地基封存和CAS初始化零楼记录。底图由同次结果的可选`mapStyle`、`mapLayout`选择；workspace提示兼容旧档，每个地图页的根地点可保存自己的环境提示，真实城市底图和已有聊天手动保存值优先；同聊天也会更新背景和示意点位。无style增量时保已存自动选择，主页不新增选择控件。

地图浏览范围与数据父树分开：地区名低调标在完整底图，建筑作点位，室内保留文字层级。底图沿原生方形画幅完整显示。UI分区参考源道路、庭院、池岸、建筑与画面边界离线制作；宫苑按真实设施域及院内线索分配。少区合并相邻区域，保存1至5区的静态轮廓和内部留白。程序不在使用时推断或剪分边界。同一展示区域提供轮廓、区名安全留白和本区点位。地图最多使用五个静态分区；未定地区的独立场地较多时，留一个完整分区容纳这些点，其余最多四个显示具名地区，避免把独立场地都挤在边缘。完整地点层级始终保留在下方树中。场地点位优先使用离线预选的可见建筑、院落和近街边落点，避开道路、区域边界和区名框；按固定顺序填入地点，新增时保留已有预选位置。合并区域及无具名区域也有静态落点，超过预选数量时沿用简要排布。与具名区域并列的无所属场地放在边缘留白。运行时不裁切或重算底图，离线UI区域与点位按同一源画幅制作；点击地区只筛下方树，全图点位和构图不随筛选重排。地区名与点位常显，仅当前、键盘聚焦或鼠标悬停的场地显示名称。主页使用同款搜索输入框；区域、建筑、楼层与房间共用递归折叠树。初始只显示顶层标题，逐层点开才见该层描述和下级；地图地名可筛选，地图换点收起旧场地详情，仅展开新场地的必要祖先；普通树仍可手动同时展开多项。点空白清选择并返回全部顶层标题。地图示意排布不表示真实行政边界或距离。可选展示提示随原地点提取产生，不增加模型请求；人工四字段编辑保持原样。

地点编辑弹窗内可展开“添加子地点”，搜索并多选已有地点，与名称、所属、描述和方位草稿一起保存；取消或无改动不提交。选中父项时其下级仍随原子树保留。三点菜单保留编辑、设为顶层地点与删除。独立“设为顶层地点”可将未归属叶子显式登记到顶层，普通编辑无改动仍不保存。父、子候选均按当前真实树的前序排列，同一分支相邻、未归属在后。手工共同父未标角色但已有明确区域子级时，默认浏览进入这个区域容器。

千窗按最近的city或scope边界分地图页：城市、独立地域、巨舰和星球可各自成页，原UUID和父树保持；国家保在原父树和编辑完整路径中，普通地图、列表与导航隐藏。已有十城使用按需静态SVG，未知城市/架空地点保通用底图，城内地点按陆地近路预置点示意，不画假行政边界。地图层级city/country/scope是原摘要/整理同次可选提示，人工普通null优先，编辑和新增同次保存。


重庆、香港、名古屋采用各自主城范围的OpenStreetMap道路和水体；香港海岸使用实际OSM coastline，重庆与名古屋海陆底面沿Natural Earth公共领域数据。名古屋本批水体仅包含已取得的闭合way，不补造缺失relation。三城来源、采集时间、原始SHA和投影记录见`assets/maps-real/catalog.json`；署名为© OpenStreetMap contributors，按[ODbL 1.0](https://www.openstreetmap.org/copyright)使用。城市落点在真实陆地近路位置预选，区名框避水并留出图钉和标签边距。

## 独立地图与素材库

同次摘要或整理共用简短中文分类目录（题材tags、地貌layoutLabels），仍只返回mapStyle/mapLayout，不给模型素材编号或SVG名单。各资产shortTags供索引和来源说明。环境类别和地貌提示：现代城市、现代小城、古风城镇、自然地形、宫苑、科幻设施、异星地表、校园（`campus`）。程序从兼容的素材稳定选取，将`mapAssetId`与地点一起保存；刷新、改名、新增素材不更换已有兼容选择。环境提示改变时重选。真实城市底图、聊天人工覆盖、页根提示、workspace旧提示依次生效。`scope`本级有稳定内容时可显示说明页，即使没有子场地也不造地图点；只有名称的空scope和空city保留在完整目录与编辑候选。

可点图库预览见`mockups/map-library.html`，默认只显示底图，辅助分区和落点可切换。`src/qianchuang-map-assets.js`集中登记实际可用素材及静态区域/落点，SVG沿现有按需读取模式加载。异星地表暂共用成熟的自然地形源：生态类优先森林/原野/海岸，岩质类优先山地/荒漠/北地，独立星球不回退成舰内设施。

现库共24张：现代城市3、现代小城3、古风城镇4、自然地形6、宫苑3、舰内设施2、校园3。17张城镇/地貌/宫苑图采用真实OSM片区及MapToPoster分层绘法，沿paper/blue/ql主题保完整路网、建筑、水面与真实植被；同色子路径合并编码，SVG几何保留。既有钟路、本丸、3校园和2舰内图继续使用原SVG及静态几何。10座命名城市保原身份、地理范围、SVG、slots与分区。

| 素材ID | 当前真实来源 |
| --- | --- |
| modern-inland | 首尔钟路旧OSM采集，原SVG/投影/几何保留；原raw SHA见本文开头。 |
| modern-coast / modern-radial | Seattle滨水街区3.4km / Karlsruhe放射城中心3km。 |
| modern-town-plain | Lemgo紧凑城镇2.5km。 |
| modern-town-river / old-town-river | Český Krumlov北侧Vltava人居2.8km / 旧城河湾1.7km，共用一次真实采集、使用不同裁窗。 |
| modern-town-coast / old-town-coast | Vannes南港2.2km / 旧港城2.5km。 |
| old-town-inland / old-town-plain | Siena旧城2km / Lucca旧城2km。 |
| terrain-forest / terrain-snow | Český Krumlov城镇与林地4.4km / Kuopio-Puijo湖滨城镇6km。 |
| terrain-coast / terrain-coast-relief | Kotor北湾2.9km / Kotor港城与山坡3.6km，真实岸线同源不同裁窗。 |
| terrain-mountain | Boulder山麓城镇5km，叠加USGS真实Index Contours主线。 |
| terrain-desert | Ouarzazate荒漠城镇4km。 |
| palace-axial / palace-courtyard-garden | 景福宫1km / Versailles主宫与近园1.3km；点位限制在真实设施域。 |
| palace-courtyard-honmaru | 二条城本丸OSM源，保原图与静态分区落点。 |
| campus-compact / campus-garden / campus-university | 东京科学技术高中 / 学习院目白 / 首尔大学冠岳既有OSM平面，保原图与静态几何。 |
| sci-fi-linear / sci-fi-ring-life | Luxury Liner Deck1甲板与旋转餐厅裁窗，CC BY-NC 4.0，保舱室与通道原几何。 |

OSM图显示© OpenStreetMap contributors，按ODbL 1.0使用；真实来源、原始SHA、投影及裁窗见`assets/maps-library/sources.json`。新17图的crop为投影米制方窗，boundsWgs84记录采集范围，输出为1000²；既有素材保其原裁窗含义。道路层级采用[MapToPoster](https://github.com/originalankur/maptoposter)的MIT绘图代码/方法；森林读取实际wood/forest面。Boulder另含[USGS The National Map](https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer)公共领域主等高线，源URL/SHA列在同一来源记录。宫苑UI区按实际院路、池岸与殿院线索分配，景福宫严格使用OSM historic宫苑relation5501517，Versailles使用其Parc/Jardin/主宫真实面。


宫苑按真实设施域、院路与园庭离线静态分配1至5区；舰内设施仍保留原自包含PNG蒙版与舱室结构，沿舱壁划分静态区域。各区提供留白、落点和全图点池，均沿既有静态接口分配，继承现有`--ql-*`主题变量。

本丸院落使用`palace/honmaru`，普通`palace/courtyard`继续使用园林庄园；未明确本丸布局时不随机抽到专用图。模型仍在原一次摘要或整理中按实际范围选择：独立本丸、和风御殿或日式生活院落群可用`scope/palace/honmaru`；刀剑乱舞、刀剣乱舞、Touken Ranbu只提供题材参考，城镇街市与野外战场沿原类型。`mapLayout`内确定的“本丸、和风院落、和风御殿、日式院落群”和Honmaru大小写、前后空白兼容为标准honmaru；不扫描卡名或地点原文来强制选图。旧园林在原同次资料合并收到明确新布局时重选，省略布局仍保已有图。素材提供1至5区、31个全图落点与独立公共点，正式地图下方显示OSM署名。

校园三图使用`campus/compact`、`campus/garden`、`campus/university`。紧凑教学与运动场、楼群庭园生活区、多院系宿舍路网分别对应三种布局，高中和小大学可共用前两者，普通学校缺少布局信息使用紧凑图。只在原mapStyle/mapLayout字段内归一明确中英文，不按校名、公立或私立身份套图；校园是否独立地图仍由实际空间范围决定，城市／国家物理父级保留。

三份已验收SVG原字节保留，均1000×1000，无校名楼名、外围壳墙、树符号或3D；仅源已登记的网球、足球、篮球、泳池增加设施标准线，未知运动场不猜类型。校园分区沿源道路、院庭与建筑边线离线制作，整栋连通建筑归同一区，少区合并相邻完整区。全图点池分别32／30／40点，另有公共点；建筑或室内地点可落在源建筑内部，运动设施优先使用同类运动场地及边缘；未知与户外地点使用避水、非建筑且非运动场的源地面。外部目录尚未包含校园时，已内置三图可直接读取本地SVG；显示保OSM署名。

## 舰内生态生活甲板

sci-fi-linear采用Robert Pearce / Eric B. Smith的[Luxury Liner Deck 1](https://gurpsland.sytes.net/geomorphs/)成熟甲板图，按[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)署名及非商业条件使用；衍生资产沿同许可，不改标为公共领域。原PNG为1740×5010，源SHA和裁窗x310/y1850/1120×1280保存在sources.json。裁取内部生态生活片区、去中庭大字和题签，保舱壁、家具、连续通道、水域及小通用舱名；将栅格源分为主题色蒙版，以自包含SVG按需载入。没有完整船壳外框。现有sci-fi-linear选择和旧sci-fi保存值共用同一资产及静态几何，不迁移聊天设置。




## 外链图库与新增图

默认地址是 `https://st-myriadknots.pages.dev/`，当前由插件仓库的 `assets/` 目录部署到 Cloudflare Pages。插件启用时，前端后台各读一次 `maps-library/catalog.json` 和 `maps-real/catalog.json`，只读取公共静态文件，不发送聊天、角色或设置。目录就绪后千窗更新显示；摘要、人物、CSE和保存流程不等待外网，也不增加模型调用。每次刷新重新读取目录，同一页面内不定时重试。

模型继续在原一次摘要或整理中选择原有 `mapStyle` / `mapLayout`。新通用图使用现有题材和地貌组合，程序从完整目录选择并保存 `mapAssetId`；已有兼容选择保持。真实城市按目录的别名匹配背景，地点UUID、父树、来源和地图范围继续来自原资料。

新增通用图时：

1. 将自包含SVG放进 `assets/maps-library/`，使用新的稳定ID和文件名，计算原文件完整SHA256。
2. 目录可使用完整对象数组，也可沿当前坐标与轮廓去重格式 `{schemaVersion:1,assets,points,contours}`；后者的 `assets` 按ID登记对象，区域轮廓索引指向 `contours`，每条轮廓的坐标索引指向 `points`。在目录添加完整对象：`id`、`family`、`layout`、`label`、`file`、`width`、`height`、`sha256`、`shortTags`、`regions`、`anchors`。题材和地貌沿 `src/qianchuang-display-hints.js` 的现有组合。SVG的viewBox可保原图裁窗起点，宽高比例须与目录一致。
3. `regions.layouts` 提供1至5区的完整静态轮廓及本区留白 `inset`；`anchors.layouts` 对应同一分区的落点，另给 `regions.neutral` 与 `anchors.neutral/all`。坐标按画面宽高的0至100表示。分区、区名和点位必须与这张SVG共用几何，沿可见道路、水岸或画面边界制作；不得把任意矩形当作地图分区。
4. 同步 `sources.json` 的真实来源、许可、SHA及处理记录；发布 `assets/` 后刷新酒馆。只添加相同题材/地貌的新图无需改插件代码或模型输出。

新增真实城市时，将SVG放进 `assets/maps-real/`，在该目录 `catalog.json` 的 `cities` 中补完整 `id/label/file/width/height/sha256`、`aliases`、陆地近路 `slots` 和 `groups:[{labelBox,slots}]`，保留来源与许可说明。别名只用于选择背景，不建立地点归属。

通常新增不同素材或地理范围使用新ID及文件名。本轮按用户明确要求统一既有模板，17张沿原ID/file/family/layout更新SVG、SHA及配套静态几何；六旧保存值读时承接对应图库，聊天偏好不重写。新目录包含完整几何，也兼容最初的轻目录：只有ID、SHA和尺寸吻合时才借用内置几何；未知且缺几何的条目跳过。

图片按目录的完整SHA版本地址读取并核验，再由宿主已有DOMPurify清理SVG。只允许图库目录下的静态SVG文件，保留内嵌PNG和本地mask/样式，不加载图片中的外部资源。目录或图片一次读取最长8秒；网络、HTTP或内容错误时，内置图使用原本地资源。外部新图离线时保留存档里的原ID，页面使用已有背景或继续展示地点文字，不保存替代ID。

能否直接访问图库取决于用户设备的网络。插件已内置的地图在图库不可达时仍可使用；之后新增而尚未随插件内置的图片需要联网读取。地点文字和父子目录沿原记录显示，摘要与保存继续原流程。


自然图采用完整真实城镇与周边地貌：街巷与建筑保留，真实水面、wood/forest及公园草地平涂，Boulder仅叠实际少量主等高线。开口海岸使用源coastline与裁窗边界构面，按实际共边岸段的land-left方向辨海陆。画幅与静态分区/落点同源；宫苑落点和区名留白留在真实设施内。

SVG样式限定在现有.qqj-generic-basemap根；道路/主线采用非缩放线宽，颜色继承原主题。地形图沿原opacity1，其余普通图库.72，生态甲板.8。离线UI轮廓按0.15%画幅简化，完整SVG路网和建筑不随UI轮廓删减；运行时继续查静态表。旧CDN目录不匹配新SHA/几何时沿原loader读本地，匹配版本仍按原流程读外链。

区域名沿原标签中心以正常主题字号呈现，近边文字向画幅内展开；仅真超长时省略，点击仍在下方显示完整地点树。键盘焦点贴文字显示下划线，标签不再占整块留白矩形。混合类型目录中，无mapRole的旧场地继续显示，内室只保文字层级并将当前位置锚到可见祖先；没有向存档补写类型。自然地形底图局部提高主题细线清晰度，其余题材原主题层级保持。

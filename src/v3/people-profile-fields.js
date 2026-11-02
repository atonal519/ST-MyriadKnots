export const PEOPLE_PROFILE_GROUPS = Object.freeze([
  Object.freeze({ key: 'basic', label: '基础信息', fields: Object.freeze([
    ['gender', '性别', 'input'], ['age', '年龄', 'input'], ['birthday', '生日', 'input'], ['bloodType', '血型', 'input'], ['zodiac', '星座', 'input'], ['species', '种族', 'input'], ['notes', '补充资料', 'textarea'],
  ]) }),
  Object.freeze({ key: 'appearance', label: '外貌', fields: Object.freeze([
    ['height', '身高', 'input'], ['weight', '体重', 'input'], ['build', '体型', 'input'], ['face', '面容', 'textarea'], ['hair', '发型发色', 'textarea'], ['eyes', '眼睛', 'textarea'],
    ['distinctiveFeatures', '辨识特征', 'textarea'], ['clothingStyle', '衣着风格', 'textarea'], ['appearance', '外貌补充', 'textarea'],
  ]) }),
  Object.freeze({ key: 'identity', label: '身份', fields: Object.freeze([
    ['occupation', '职业', 'input'], ['organization', '所属组织', 'input'], ['socialIdentity', '社会身份', 'input'], ['background', '背景经历', 'textarea'], ['identityRelations', '重要身份关系', 'textarea'],
    ['nationality', '国籍', 'input'], ['birthplace', '出生地', 'input'], ['residence', '常住地', 'input'], ['languages', '使用语言', 'textarea'], ['skills', '技能与能力', 'textarea'],
  ]) }),
  Object.freeze({ key: 'personality', label: '性格', fields: Object.freeze([
    ['personality', '核心性格', 'textarea'], ['conduct', '处事方式', 'textarea'], ['expression', '表达习惯', 'textarea'], ['likes', '喜好', 'textarea'], ['dislikes', '厌恶', 'textarea'], ['principles', '原则与底线', 'textarea'],
    ['mbti', 'MBTI', 'input'], ['enneagram', '九型人格', 'input'], ['alignment', '道德阵营', 'input'],
  ]) }),
  Object.freeze({ key: 'nsfw', label: 'NSFW', fields: Object.freeze([['nsfw', '成人向资料', 'textarea']]) }),
]);

export const PEOPLE_PROFILE_FIELDS = Object.freeze(['name', 'aliases', ...PEOPLE_PROFILE_GROUPS.flatMap(group => group.fields.map(([field]) => field))]);
export const LEGACY_PEOPLE_PROFILE_FIELDS = Object.freeze(['name', 'aliases', 'background', 'appearance', 'personality', 'notes']);
export const PEOPLE_PROFILE_FIELD_SET = new Set(PEOPLE_PROFILE_FIELDS);

export function hasPeopleProfileMaterial(profile) {
  return PEOPLE_PROFILE_FIELDS.some(field => field !== 'name' && field !== 'aliases' && String(profile?.[field] ?? '').trim().length > 0);
}

export const PEOPLE_PROFILE_LABELS = Object.freeze(Object.fromEntries([
  ['name', '姓名'], ['aliases', '别名'], ...PEOPLE_PROFILE_GROUPS.flatMap(group => group.fields.map(([field, label]) => [field, label])),
]));

export const PEOPLE_PROFILE_DEFINITIONS = Object.freeze({
  name: '人物当前正式姓名或最稳定的主要称呼。',
  aliases: '人物长期使用或被稳定称呼的别名、昵称、代称与头衔。',
  gender: '有明确依据的性别认同或作品设定，不由外貌推断。',
  age: '有明确依据的实际年龄、年龄段或不老等年龄设定，不把外观年龄当实际年龄。',
  birthday: '明确的出生日期、生日或作品内对应纪念日。',
  bloodType: '材料明确给出的血型或作品对应设定；不依据性格、外貌或亲属血型推算。',
  zodiac: '材料明确给出的星座设定；不根据生日或人物性格推算。',
  species: '人物所属种族、物种或明确的非人类别。',
  notes: '无法归入其他字段、但适合长期保存的稳定人物事实；保留独有信息，不重复已拆出的字段值，不写整理或核验评语。',
  height: '明确身高、身高范围或相对身高。',
  weight: '明确体重或体重范围，保留单位及必要时点；不由身高、体型推算。',
  build: '身体骨架、体态、比例、肌肉或胖瘦等整体体型，不写五官和衣着。',
  face: '脸型、五官、肤色与面部观感，不重复发型、眼睛和身体体型。',
  hair: '稳定的发型、发色、发质及相关特征。',
  eyes: '瞳色、眼型、目光等眼部特征。',
  distinctiveFeatures: '伤疤、纹身、痣、气味、声音等能长期辨认人物的特征。',
  clothingStyle: '长期偏好的穿衣风格、常见搭配或固定装束，不把单次换装固化。',
  appearance: '无法归入身高、体重、体型、面容、头发、眼睛、辨识特征或衣着的外貌补充。',
  occupation: '人物从事的职业、工作或长期承担的专业职责。',
  organization: '人物明确所属、效忠或任职的组织与势力阵营。',
  socialIdentity: '职业和组织之外的社会地位、公开身份、阶层、头衔或法律身份。',
  background: '塑造人物的出身、成长、教育与关键过往经历。',
  identityRelations: '亲属、师徒、上下级、婚约等由身份形成的重要关系，不写短期关系气氛。',
  nationality: '明确的国籍或作品对应的国家身份；不把种族、出生地或组织当作国籍。',
  birthplace: '明确出生的地点；不把常住地、籍贯或成长地直接当作出生地。',
  residence: '长期常住地或固定居所，保留必要时期与条件；不把当前出现地点或短暂停留当作常住地。',
  languages: '明确可使用的语言及已给出的熟练度；不凭国籍、种族或一次台词推断。',
  skills: '明确具备的长期技艺、专业技能或特殊能力，保留适用条件及已给出的熟练度；不由一次表现夸大长期能力。',
  personality: '跨情境较稳定的核心性格倾向，不把一时情绪当人格；保留具体描写，不用MBTI或九型标签替代，也不重复标签。',
  conduct: '人物处理事务、作决定、合作或面对冲突时较稳定的做法。',
  expression: '稳定的说话方式、语气、口头禅、礼仪或非语言表达习惯。',
  likes: '有持续依据的偏好、兴趣、珍视对象或舒适事物。',
  dislikes: '有持续依据的反感、畏惧、禁忌或排斥事物。',
  principles: '人物稳定坚持的价值判断、原则、承诺边界与不可逾越的底线。',
  mbti: '材料明确给出的MBTI类型，可保留明确的细分后缀；不从性格、言行推断，不反推或替代具体性格。',
  enneagram: '材料明确给出的九型人格类型及翼型等限定；不从性格、MBTI或行为推断。',
  alignment: '材料明确给出的道德阵营或作品对应的稳定道德取向标签；不同于所属组织、势力或临时站队，不从行为自行分类。',
  nsfw: '只记录有明确依据且稳定的成人向身体特征、偏好、边界与亲密设定；充分保留不同的明确偏好，合并同义内容，不为精简而丢掉设定。必须移除具体经历、个别事例、对白、动作过程、临时反应、来源举证及原因分析、解释或推测；不能把一次行为升格为稳定偏好，也不能因删除经历而编造概括。保留人工明确设定与偏好含义，其中的叙事或例子只提取已明确表达的稳定设定，不照抄经历。普通外貌归入对应外貌字段；更新时整合为一份现行资料，不在旧文末尾逐次追加；没有新资料的增量整理可省略本字段。',
});

export function emptyPeopleProfileFields() {
  return Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, '']));
}

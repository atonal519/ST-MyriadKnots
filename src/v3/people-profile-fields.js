export const PEOPLE_PROFILE_GROUPS = Object.freeze([
  Object.freeze({ key: 'basic', label: '基础信息', fields: Object.freeze([
    ['gender', '性别', 'input'], ['age', '年龄', 'input'], ['birthday', '生日', 'input'], ['species', '种族', 'input'], ['notes', '补充资料', 'textarea'],
  ]) }),
  Object.freeze({ key: 'appearance', label: '外貌', fields: Object.freeze([
    ['height', '身高', 'input'], ['build', '体型', 'input'], ['face', '面容', 'textarea'], ['hair', '发型发色', 'textarea'], ['eyes', '眼睛', 'textarea'],
    ['distinctiveFeatures', '辨识特征', 'textarea'], ['clothingStyle', '衣着风格', 'textarea'], ['appearance', '外貌补充', 'textarea'],
  ]) }),
  Object.freeze({ key: 'identity', label: '身份', fields: Object.freeze([
    ['occupation', '职业', 'input'], ['organization', '所属组织', 'input'], ['socialIdentity', '社会身份', 'input'], ['background', '背景经历', 'textarea'], ['identityRelations', '重要身份关系', 'textarea'],
  ]) }),
  Object.freeze({ key: 'personality', label: '性格', fields: Object.freeze([
    ['personality', '核心性格', 'textarea'], ['conduct', '处事方式', 'textarea'], ['expression', '表达习惯', 'textarea'], ['likes', '喜好', 'textarea'], ['dislikes', '厌恶', 'textarea'], ['principles', '原则与底线', 'textarea'],
  ]) }),
  Object.freeze({ key: 'nsfw', label: 'NSFW', fields: Object.freeze([['nsfw', '成人向资料', 'textarea']]) }),
]);

export const PEOPLE_PROFILE_FIELDS = Object.freeze(['name', 'aliases', ...PEOPLE_PROFILE_GROUPS.flatMap(group => group.fields.map(([field]) => field))]);
export const LEGACY_PEOPLE_PROFILE_FIELDS = Object.freeze(['name', 'aliases', 'background', 'appearance', 'personality', 'notes']);
export const PEOPLE_PROFILE_FIELD_SET = new Set(PEOPLE_PROFILE_FIELDS);

export const PEOPLE_PROFILE_LABELS = Object.freeze(Object.fromEntries([
  ['name', '姓名'], ['aliases', '别名'], ...PEOPLE_PROFILE_GROUPS.flatMap(group => group.fields.map(([field, label]) => [field, label])),
]));

export const PEOPLE_PROFILE_DEFINITIONS = Object.freeze({
  name: '人物当前正式姓名或最稳定的主要称呼。',
  aliases: '人物长期使用或被稳定称呼的别名、昵称、代称与头衔。',
  gender: '有明确依据的性别认同或作品设定，不由外貌推断。',
  age: '有明确依据的实际年龄、年龄段或不老等年龄设定，不把外观年龄当实际年龄。',
  birthday: '明确的出生日期、生日或作品内对应纪念日。',
  species: '人物所属种族、物种或明确的非人类别。',
  notes: '无法归入其他字段、但适合长期保存的稳定人物资料。',
  height: '明确身高、身高范围或相对身高。',
  build: '身体骨架、体态、比例、肌肉或胖瘦等整体体型，不写五官和衣着。',
  face: '脸型、五官、肤色与面部观感，不重复发型、眼睛和身体体型。',
  hair: '稳定的发型、发色、发质及相关特征。',
  eyes: '瞳色、眼型、目光等眼部特征。',
  distinctiveFeatures: '伤疤、纹身、痣、气味、声音等能长期辨认人物的特征。',
  clothingStyle: '长期偏好的穿衣风格、常见搭配或固定装束，不把单次换装固化。',
  appearance: '无法归入身高、体型、面容、头发、眼睛、辨识特征或衣着的外貌补充。',
  occupation: '人物从事的职业、工作或长期承担的专业职责。',
  organization: '人物明确所属、效忠或任职的组织与阵营。',
  socialIdentity: '职业和组织之外的社会地位、公开身份、阶层、头衔或法律身份。',
  background: '塑造人物的出身、成长、教育与关键过往经历。',
  identityRelations: '亲属、师徒、上下级、婚约等由身份形成的重要关系，不写短期关系气氛。',
  personality: '跨情境较稳定的核心性格倾向，不把一时情绪当人格。',
  conduct: '人物处理事务、作决定、合作或面对冲突时较稳定的做法。',
  expression: '稳定的说话方式、语气、口头禅、礼仪或非语言表达习惯。',
  likes: '有持续依据的偏好、兴趣、珍视对象或舒适事物。',
  dislikes: '有持续依据的反感、畏惧、禁忌或排斥事物。',
  principles: '人物稳定坚持的价值判断、原则、承诺边界与不可逾越的底线。',
  nsfw: '有明确依据且适合长期建档的成人向身体、偏好、边界或亲密设定。',
});

export function emptyPeopleProfileFields() {
  return Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, '']));
}

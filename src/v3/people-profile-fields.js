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

export function emptyPeopleProfileFields() {
  return Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, '']));
}

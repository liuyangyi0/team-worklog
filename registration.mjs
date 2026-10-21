export const REGISTRATION_NAMES = Object.freeze([
  "杨示例一",
  "韩示例二",
  "胡示例三",
  "胡示例四",
  "寇示例五",
  "李示例六",
  "刘示例七",
  "刘示例八",
  "牛示例九",
  "乔示例十",
  "尚示例十一",
  "宋示例十二",
  "唐示例十三",
  "王示例十四",
  "王示例十五",
  "王示例十六",
  "王示例十七",
  "魏示例十八",
  "向示例十九",
  "杨示例二十",
  "易示例二十一",
  "尤示例二十二",
]);
const allowedNames = new Set(REGISTRATION_NAMES);
export function registrationName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!allowedNames.has(name))
    throw Object.assign(new Error("请填写真实姓名"), { status: 400 });
  return name;
}

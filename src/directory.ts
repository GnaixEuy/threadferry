import type { DirectoryUser } from "./types.js";

const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

export class DirectoryUserNotFoundError extends Error {}

export async function resolveDirectoryUser(
  reference: string,
  searchUsers?: (keywords: string[]) => Promise<DirectoryUser[]>,
): Promise<DirectoryUser> {
  if (reference.startsWith("id:")) {
    const id = reference.slice(3);
    if (!USER_ID.test(id)) throw new Error("userid 无效。");
    return { id, name: id };
  }
  if (!reference || !searchUsers) throw new Error("当前启动方式不支持按姓名查询用户。");
  let users: DirectoryUser[];
  try {
    users = await searchUsers([reference]);
  } catch {
    throw new Error("企业微信通讯录查询失败。请检查 wecom-cli 授权，或使用 id:<userid>。");
  }
  const normalized = reference.toLocaleLowerCase();
  const exact = users.filter((user) => user.name.toLocaleLowerCase() === normalized || user.alias?.toLocaleLowerCase() === normalized);
  const matches = exact.length > 0 ? exact : users;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new DirectoryUserNotFoundError(`通讯录中没有找到“${reference}”。也可以使用 id:<userid>。`);
  const choices = matches.slice(0, 10).map((user) => {
    const department = user.departments?.length ? `，${user.departments.join(" / ")}` : "";
    return `${user.name}${user.alias ? `（${user.alias}）` : ""}${department}：id:${user.id}`;
  });
  throw new Error(`找到多个“${reference}”，请使用对应的 id：${choices.join("；")}`);
}

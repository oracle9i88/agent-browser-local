import { DEFAULT_SPACE_ID } from "./space-manager.mjs";

/**
 * 标签页归属：记录每个 tab（webContents id）所属的 Agent Space。
 *
 * - 未绑定的 tab 一律归属默认 Space（fail-closed：不会漂移到未知 Space）；
 * - 一个 tab 同一时刻只属于一个 Space；换绑必须显式 rebind；
 * - controller / 迁移向导通过 ownerOf 决定 Cookie 注入与读取的 partition。
 */
export function createTabOwnership({ defaultSpaceId = DEFAULT_SPACE_ID } = {}) {
  if (!defaultSpaceId) throw new Error("tab ownership requires defaultSpaceId");
  const ownership = new Map();

  function bind(tabId, spaceId) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error(`Invalid tab id: ${tabId}`);
    }
    if (!spaceId) throw new Error("tab ownership requires a space id");
    ownership.set(tabId, spaceId);
    return spaceId;
  }

  function ownerOf(tabId) {
    return ownership.get(tabId) || defaultSpaceId;
  }

  function unbind(tabId) {
    return ownership.delete(tabId);
  }

  function rebind(tabId, spaceId) {
    if (!ownership.has(tabId)) {
      throw new Error(`Tab ${tabId} is not bound yet; use bind()`);
    }
    return bind(tabId, spaceId);
  }

  function tabsOf(spaceId) {
    return [...ownership.entries()]
      .filter(([, space]) => space === spaceId)
      .map(([tabId]) => tabId);
  }

  return { bind, ownerOf, unbind, rebind, tabsOf, defaultSpaceId };
}

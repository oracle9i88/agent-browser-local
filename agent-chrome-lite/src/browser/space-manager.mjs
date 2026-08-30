import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SPACE_ID = "default";

function spacePartition(spaceId) {
  return `abl-space-${spaceId}`;
}

function persistedPartitionName(partition) {
  return `persist:${partition}`;
}

/**
 * Agent Space 管理。
 *
 * 每个 Space 拥有一个独立的 Electron 持久化 partition（persist:abl-space-<id>），
 * Cookie / storage 由 Electron 按 partition 结构性隔离：不同 Space 的 Cookie
 * 存储互不可见。登录态迁移以 Space 为注入目标，不再写入 defaultSession。
 *
 * sessionFactory 允许测试注入内存实现；生产环境默认为
 * electron.session.fromPartition(persist:<partition>)。
 */
export function createSpaceManager({
  spacesDir,
  sessionFactory,
  now = () => new Date().toISOString(),
} = {}) {
  if (!spacesDir) throw new Error("space manager requires spacesDir");

  let registry = null;

  async function load() {
    if (registry) return registry;
    try {
      const raw = await readFile(path.join(spacesDir, "registry.json"), "utf8");
      const parsed = JSON.parse(raw);
      registry = Array.isArray(parsed?.spaces) ? parsed : { spaces: [] };
    } catch {
      registry = { spaces: [] };
    }
    return registry;
  }

  async function save() {
    await mkdir(spacesDir, { recursive: true });
    const tempPath = path.join(spacesDir, `registry.json.${process.pid}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path.join(spacesDir, "registry.json"));
  }

  function validId(id) {
    return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id);
  }

  async function ensureSpace(spaceId, label) {
    if (!validId(spaceId)) throw new Error(`Invalid space id: ${spaceId}`);
    const document_ = await load();
    let space = document_.spaces.find((candidate) => candidate.id === spaceId);
    if (!space) {
      space = {
        id: spaceId,
        label: label || spaceId,
        partition: spacePartition(spaceId),
        createdAt: now(),
      };
      document_.spaces.push(space);
      await save();
    }
    return space;
  }

  async function ensureDefaultSpace() {
    return ensureSpace(DEFAULT_SPACE_ID, "默认 Space");
  }

  async function listSpaces() {
    const document_ = await load();
    if (!document_.spaces.some((space) => space.id === DEFAULT_SPACE_ID)) {
      await ensureDefaultSpace();
    }
    return (await load()).spaces.map((space) => ({ ...space }));
  }

  async function getSpace(spaceId) {
    const document_ = await load();
    const space = document_.spaces.find((candidate) => candidate.id === spaceId);
    if (!space) throw new Error(`Unknown agent space: ${spaceId}`);
    return { ...space };
  }

  function sessionFor(space) {
    const resolved = typeof space === "string" ? spacePartition(space) : space.partition;
    if (!sessionFactory) {
      throw new Error("space manager requires sessionFactory in production");
    }
    const fromPartition =
      typeof sessionFactory === "function"
        ? sessionFactory
        : sessionFactory.fromPartition.bind(sessionFactory);
    return fromPartition(persistedPartitionName(resolved));
  }

  return {
    ensureDefaultSpace,
    ensureSpace,
    listSpaces,
    getSpace,
    sessionFor,
    registryPath: path.join(spacesDir, "registry.json"),
  };
}

/**
 * society（协作模式）的纯数据定义。
 *
 * **本文件不 import 任何东西**，尤其不依赖 store.ts —— society 的类型要能被
 * 持久化层、树视图、命令层同时使用，任何一侧的依赖都会把这里变成交汇点。
 * 需要 id 的地方由调用方用 store.ts 的 `newId()`（12 位 hex），规则一致即可，
 * 不必把生成器搬进来。
 */

/** 四级固定层级：产品经理 → 架构师 → 开发组组长 → 开发者。树里的展示顺序也照这个排（见 societyTree.ts）。 */
export type SocietyLevel = 'product' | 'architect' | 'lead' | 'dev';

/** 层级的中文名。新增层级时这里会因 `Record` 缺键而在编译期报错。 */
const LEVEL_LABEL: Record<SocietyLevel, string> = {
  product: '产品经理',
  architect: '架构师',
  lead: '开发组组长',
  dev: '开发者',
};

export function levelLabel(level: SocietyLevel): string {
  return LEVEL_LABEL[level];
}

/** 每个层级的职责与上下级，用于生成角色的 CLAUDE.md（逐层委派工作流）。 */
export interface LevelGuide {
  /** 职责说明（一段话，写进 CLAUDE.md） */
  duty: string;
  /** 直接上级的层级名，顶层是「用户（董事）」 */
  up: string;
  /** 直接下级的层级名，底层是「无」 */
  down: string;
}

const LEVEL_GUIDE: Record<SocietyLevel, LevelGuide> = {
  product: {
    duty: '把用户（董事）的需求变成一份明确的需求文档：要做什么、为什么、怎么算完成（验收标准）。需求模糊时先问用户澄清，不要猜。',
    up: '用户（董事）',
    down: '架构师',
  },
  architect: {
    duty: '读需求文档，产出技术架构设计：模块怎么划分、模块间接口、关键技术选型与理由。',
    up: '产品经理',
    down: '开发组组长',
  },
  lead: {
    duty: '读架构设计，拆成细粒度的模块任务，逐个分给开发者实现；测试/复测执行也任命一个开发者去做，该测试开发者的工作目录填你自己这一层（即你自己的工作目录），别另起子目录；开发者回报后你做测试验收——通过就回报架构师，不通过就打回开发者重做。',
    up: '架构师',
    down: '开发者',
  },
  dev: {
    duty: '领组长分给你的具体模块任务，读相关代码，实现它，完成后回报组长。',
    up: '开发组组长',
    down: '无',
  },
};

export function levelGuide(level: SocietyLevel): LevelGuide {
  return LEVEL_GUIDE[level];
}

/** 每个层级该在 memory.md 里记什么（记忆粒度，逐层由粗到细）。 */
const LEVEL_MEMORY: Record<SocietyLevel, string> = {
  product: '记全局视野：需求全景、目标、验收标准、关键决策。',
  architect: '记架构：模块划分、模块间接口、技术选型与理由。',
  lead: '记模块架构：任务分配、各模块状态、测试验收结果。',
  dev: '记详细实现：改动的文件、函数、关键代码细节、待办。',
};

export function levelMemory(level: SocietyLevel): string {
  return LEVEL_MEMORY[level];
}

/** society 里的一个角色。一个角色**恰好**对应一个终端条目（terminalEntryId）。 */
export interface SocietyRole {
  /** 12 位 hex，与 store.ts 的 newId 同一规则 */
  id: string;
  /** AI 自起名，初始可以是空串（树里回落成「未命名·<层级>」） */
  name: string;
  level: SocietyLevel;
  /** 职责描述，树里显示为 description */
  duty: string;
  /** 角色工作目录（绝对路径） */
  dir: string;
  /** 关联到 terminals.json 里 TerminalEntry.id */
  terminalEntryId: string;
}

/** 一个 society = 一个项目根目录 + 一组角色。 */
export interface Society {
  id: string;
  name: string;
  /** 项目根目录（绝对路径） */
  rootDir: string;
  roles: SocietyRole[];
}

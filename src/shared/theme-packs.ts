/**
 * 主题包：数据驱动的 token 覆盖集。
 *
 * 每个包给 light / dark 两套语义色；--accent 不在这里，仍由用户单独选，
 * 所以「主题包」与「强调色」是两个正交的维度。
 */
export interface ThemeColors {
  canvas: string
  layer: string
  hover: string
  hover2: string
  fg: string
  fg2: string
  fg3: string
  border: string
  border2: string
  input: string
  scroll: string
  accent_soft: string
  warm: string
  danger: string
  success: string
}

export interface ThemePack {
  light: ThemeColors
  dark: ThemeColors
}

/**
 * 每个主题包**推荐的强调色** —— 主题包与强调色的联动就落在这里。
 *
 * 为什么需要：主题包给的是中性色（画布、层次、文字、边框），它的"性格"体现在冷暖与明暗；
 * 而强调色是唯一的彩色。两者若各选各的，很容易出现"粉色的包 + 绿色的按钮"这种打架。
 * 有了这张表，设置页里换包就能顺手带出配套的强调色。
 *
 * 值都取自同一个色系（包的色相），且都满足 --accent-text 的 4.5:1 下限 ——
 * 不满足的会被 applyTheme 的 ensureTextContrast 现场校正，但那会偏离色相，
 * 所以这里就选够深的。
 *
 * 用户改了强调色之后，换包**不再覆盖**（设置页里记"是否自定义过"）。
 */
export const PACK_ACCENT: Record<string, string> = {
  '冰川蓝': '#0891B2',
  '墨黑': '#525252',
  '奶咖棕': '#A16207',
  '暖沙': '#B45309',
  '暮色': '#C2410C',
  '柠檬黄': '#CA8A04',
  '樱花粉': '#DB2777',
  '海盐蓝': '#2563EB',
  '莓果粉': '#BE185D',
  '薄荷绿': '#059669',
  '薰衣草紫': '#7C3AED',
  '蜜桃橘': '#EA580C',
  '青竹': '#0D9488',
  '香芋紫': '#9333EA',
}

/** 取某个包的推荐强调色；包不认识时回退到默认青。 */
export function accentForPack(packName: string): string {
  return PACK_ACCENT[packName] ?? '#0D9488'
}

export const THEME_PACKS: Record<string, ThemePack> = {
  '冰川蓝': {
    light: { canvas: '#EEF8FA', layer: '#FFFFFF', hover: '#D9F0F4', hover2: '#C4E6EC', fg: '#1E3B46', fg2: '#6B9BA9', fg3: '#A5C4CD', border: '#D2EBEF', border2: '#B3D8DF', input: 'rgba(255,255,255,0.9)', scroll: '#B2D6DD', accent_soft: '#D9F1F5', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#122026', layer: '#192B31', hover: '#263C43', hover2: '#2E4850', fg: '#E9F4F6', fg2: '#A2C1CA', fg3: '#6C8791', border: '#3E5A61', border2: '#4F707A', input: 'rgba(25,43,49,0.9)', scroll: '#4F707A', accent_soft: '#1E3E47', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '墨黑': {
    light: { canvas: '#F5F5F5', layer: '#FFFFFF', hover: '#EFEFEF', hover2: '#E5E5E5', fg: '#171717', fg2: '#737373', fg3: '#B3B3B3', border: '#E5E5E5', border2: '#D4D4D4', input: 'rgba(255,255,255,0.8)', scroll: '#C9C9C9', accent_soft: '#E4E4E4', warm: '#EA580C', danger: '#DC2626', success: '#16A34A' },
    dark: { canvas: '#141414', layer: '#1E1E1E', hover: '#2A2A2A', hover2: '#333333', fg: '#F2F2F2', fg2: '#A0A0A0', fg3: '#6B6B6B', border: '#303030', border2: '#454545', input: 'rgba(30,30,30,0.9)', scroll: '#3E3E3E', accent_soft: '#2E2E2E', warm: '#FB923C', danger: '#F87171', success: '#4ADE80' },
  },
  '奶咖棕': {
    light: { canvas: '#F8F1EA', layer: '#FFFFFF', hover: '#F0E3D6', hover2: '#E6D3C2', fg: '#513A28', fg2: '#A98A70', fg3: '#CDB7A2', border: '#EADCD0', border2: '#D8C2B0', input: 'rgba(255,255,255,0.9)', scroll: '#D5C0AD', accent_soft: '#F2E6DB', warm: '#D98A5F', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#231A12', layer: '#2C211A', hover: '#3A2E24', hover2: '#44362A', fg: '#F3ECE4', fg2: '#C2A88E', fg3: '#8C7663', border: '#4F4135', border2: '#635144', input: 'rgba(44,33,26,0.9)', scroll: '#635144', accent_soft: '#4E3A2A', warm: '#E8A37A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '暖沙': {
    light: { canvas: '#F7F4EC', layer: '#FFFFFF', hover: '#F2EDDF', hover2: '#EAE2CC', fg: '#2A2620', fg2: '#7E7666', fg3: '#B0A896', border: '#EAE2CE', border2: '#D6CBA8', input: 'rgba(255,255,255,0.78)', scroll: '#CDBE9C', accent_soft: '#F0E5C9', warm: '#B45309', danger: '#DC2626', success: '#16A34A' },
    dark: { canvas: '#201D14', layer: '#2A2419', hover: '#372D1F', hover2: '#423626', fg: '#F1EBDD', fg2: '#ABA18A', fg3: '#776E56', border: '#3B2F1E', border2: '#53412C', input: 'rgba(42,36,25,0.85)', scroll: '#463723', accent_soft: '#43351F', warm: '#FCD34D', danger: '#F87171', success: '#4ADE80' },
  },
  '暮色': {
    light: { canvas: '#FAF6F4', layer: '#FFFFFF', hover: '#F5EEEA', hover2: '#EEE2DC', fg: '#2B1F1A', fg2: '#8A7264', fg3: '#BBA396', border: '#F0E2D8', border2: '#DEC8B4', input: 'rgba(255,255,255,0.75)', scroll: '#D8C0AE', accent_soft: '#F6DFD3', warm: '#C2410C', danger: '#DC2626', success: '#16A34A' },
    dark: { canvas: '#221C18', layer: '#2C2420', hover: '#3A2D26', hover2: '#45352C', fg: '#F3EBE4', fg2: '#B39C88', fg3: '#7E6B57', border: '#3E2F25', border2: '#573F30', input: 'rgba(44,36,32,0.85)', scroll: '#4C3A2D', accent_soft: '#4A3325', warm: '#FDBA74', danger: '#F87171', success: '#4ADE80' },
  },
  '柠檬黄': {
    light: { canvas: '#FEFAE9', layer: '#FFFFFF', hover: '#FBF2C8', hover2: '#F8E8A8', fg: '#4F4517', fg2: '#B8A600', fg3: '#DCD49A', border: '#F2E8B8', border2: '#E7D882', input: 'rgba(255,255,255,0.9)', scroll: '#E8D36A', accent_soft: '#FCF2C6', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#241F10', layer: '#2C2617', hover: '#3A3117', hover2: '#453A1D', fg: '#F8F4DF', fg2: '#D5C87C', fg3: '#95885A', border: '#4D4421', border2: '#63562B', input: 'rgba(44,38,23,0.9)', scroll: '#63562B', accent_soft: '#4E4118', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '樱花粉': {
    light: { canvas: '#FDF3F6', layer: '#FFFFFF', hover: '#FBE7EE', hover2: '#F8D8E4', fg: '#5A2B3B', fg2: '#B38894', fg3: '#D9BCC6', border: '#F4DCE4', border2: '#EBC3D0', input: 'rgba(255,255,255,0.9)', scroll: '#EBB3C5', accent_soft: '#FCE4ED', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#241A1E', layer: '#2C2227', hover: '#3A2E34', hover2: '#443239', fg: '#F5E7EC', fg2: '#C6A7B2', fg3: '#8A6E7A', border: '#4A3B42', border2: '#5E4A54', input: 'rgba(44,34,39,0.9)', scroll: '#5E4A54', accent_soft: '#4A3039', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '海盐蓝': {
    light: { canvas: '#EFF6FB', layer: '#FFFFFF', hover: '#DDEBF6', hover2: '#C9DEED', fg: '#1E3A4E', fg2: '#6890A6', fg3: '#A6BFCE', border: '#D5E5F0', border2: '#B7CFDF', input: 'rgba(255,255,255,0.9)', scroll: '#B4CFDF', accent_soft: '#DCEBF7', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#131E28', layer: '#1B2937', hover: '#273847', hover2: '#2F4252', fg: '#E9F2F8', fg2: '#A3BCCA', fg3: '#6B8595', border: '#3E515F', border2: '#506A7B', input: 'rgba(27,41,55,0.9)', scroll: '#506A7B', accent_soft: '#203B4E', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '莓果粉': {
    light: { canvas: '#FCF0F3', layer: '#FFFFFF', hover: '#F9DCE4', hover2: '#F3C3D2', fg: '#5A2033', fg2: '#B2788B', fg3: '#D9B1BF', border: '#F4D6DE', border2: '#EBB4C4', input: 'rgba(255,255,255,0.9)', scroll: '#EEAFC1', accent_soft: '#FADCE5', warm: '#E07A9B', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#271520', layer: '#311C29', hover: '#412B38', hover2: '#4B3342', fg: '#F8E9EF', fg2: '#CE9DAE', fg3: '#96687D', border: '#55404D', border2: '#6C5362', input: 'rgba(49,28,41,0.9)', scroll: '#6C5362', accent_soft: '#552C40', warm: '#EF9BB6', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '薄荷绿': {
    light: { canvas: '#EFF9F3', layer: '#FFFFFF', hover: '#DDF3E6', hover2: '#C9EAD7', fg: '#1E4630', fg2: '#6FA189', fg3: '#A9C9B7', border: '#D6EEDF', border2: '#B9DFC6', input: 'rgba(255,255,255,0.9)', scroll: '#B8DCC7', accent_soft: '#DCF4E6', warm: '#E8A87C', danger: '#E57373', success: '#35B37A' },
    dark: { canvas: '#152019', layer: '#1D2B22', hover: '#2A3B30', hover2: '#334739', fg: '#EAF5EC', fg2: '#A7C9B2', fg3: '#6E8F79', border: '#3E5346', border2: '#4F6658', input: 'rgba(29,43,34,0.9)', scroll: '#4F6658', accent_soft: '#264433', warm: '#F3B58A', danger: '#F58B8B', success: '#7ED9A6' },
  },
  '薰衣草紫': {
    light: { canvas: '#F4F0FB', layer: '#FFFFFF', hover: '#E7DFF8', hover2: '#D9CCF2', fg: '#3A2E55', fg2: '#8E7BB0', fg3: '#BCAECD', border: '#E4DCF4', border2: '#CDBEE8', input: 'rgba(255,255,255,0.9)', scroll: '#CBB9E5', accent_soft: '#EAE2F8', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#1D1830', layer: '#252040', hover: '#332B52', hover2: '#3B3160', fg: '#EDE8F9', fg2: '#B4A6D4', fg3: '#7E6FA1', border: '#463C66', border2: '#5A4E82', input: 'rgba(37,32,64,0.9)', scroll: '#5A4E82', accent_soft: '#372D5C', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '蜜桃橘': {
    light: { canvas: '#FFF4EC', layer: '#FFFFFF', hover: '#FFE9DA', hover2: '#FFD9C2', fg: '#5A2E1C', fg2: '#C08B72', fg3: '#E0BCA7', border: '#F7DFCE', border2: '#EFC3A6', input: 'rgba(255,255,255,0.9)', scroll: '#F0B28F', accent_soft: '#FFE7D6', warm: '#F08A3C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#271A12', layer: '#30231A', hover: '#40301F', hover2: '#4B3725', fg: '#F7ECE3', fg2: '#D0A488', fg3: '#966C55', border: '#513D2B', border2: '#684B34', input: 'rgba(48,35,26,0.9)', scroll: '#684B34', accent_soft: '#52331F', warm: '#F5A45E', danger: '#F58B8B', success: '#8FD4B8' },
  },
  '青竹': {
    light: { canvas: '#F4FAF8', layer: '#FFFFFF', hover: '#F1F5F3', hover2: '#E8EFEB', fg: '#1A1A1A', fg2: '#6B7280', fg3: '#A8AEB6', border: '#E4EDE8', border2: '#CBD8D0', input: 'rgba(255,255,255,0.72)', scroll: '#C4D2C8', accent_soft: '#D7F0EB', warm: '#EA580C', danger: '#DC2626', success: '#16A34A' },
    dark: { canvas: '#1E2422', layer: '#283029', hover: '#334036', hover2: '#3B4B41', fg: '#EDF2EE', fg2: '#9DAFA4', fg3: '#6E8880', border: '#35443B', border2: '#48604F', input: 'rgba(40,48,41,0.85)', scroll: '#41544A', accent_soft: '#254B45', warm: '#FB923C', danger: '#F87171', success: '#4ADE80' },
  },
  '香芋紫': {
    light: { canvas: '#F7F1FA', layer: '#FFFFFF', hover: '#EEE0F4', hover2: '#E2CEEB', fg: '#4A2F55', fg2: '#A17FAD', fg3: '#CBB2D3', border: '#EADEF0', border2: '#D6BFE0', input: 'rgba(255,255,255,0.9)', scroll: '#D6BEE0', accent_soft: '#EFE2F5', warm: '#E8A87C', danger: '#E57373', success: '#7FC8A9' },
    dark: { canvas: '#231A2C', layer: '#2C2137', hover: '#3A2E47', hover2: '#443653', fg: '#F0E8F4', fg2: '#BCA3C7', fg3: '#8A6F97', border: '#4C3D59', border2: '#5F4D70', input: 'rgba(44,33,55,0.9)', scroll: '#5F4D70', accent_soft: '#412B50', warm: '#F3B58A', danger: '#F58B8B', success: '#8FD4B8' },
  },
}

export const THEME_PACK_NAMES: string[] = ["冰川蓝", "墨黑", "奶咖棕", "暖沙", "暮色", "柠檬黄", "樱花粉", "海盐蓝", "莓果粉", "薄荷绿", "薰衣草紫", "蜜桃橘", "青竹", "香芋紫"]

/**
 * 默认主题包。
 *
 * 这个值必须和 settings.ts 的 DEFAULT_SETTINGS.theme_pack 一致（「青竹」，accent #0D9488）。
 * 共用的 settings 表要求默认值一致，否则同一个库被两个客户端先后打开时会表现跳变。
 *
 * 这里曾经写的是「墨黑」，与 settings.ts 的「青竹」并存了很久；两侧都有各自的使用者，
 * 谁也没发现。是 E2E 改成跑夹具库（空库）之后才暴露的：themecheck 断言默认是墨黑，
 * 而它此前一直是通过读用户库里存的 theme_pack=墨黑 才「过」的。
 * 现在由 settings.test.ts 里的一条断言把这两个值钉在一起，防止再次分叉。
 */
export const DEFAULT_THEME_PACK = '青竹'

export function resolveThemePack(name: string | undefined): ThemePack {
  return THEME_PACKS[name ?? ''] ?? THEME_PACKS[DEFAULT_THEME_PACK]
}

// ---------------------------------------------------------------- 用户自定义配色

/**
 * 可自定义的主题 token。
 *
 * 只收 #RRGGBB 的几项：其余 token（input / scroll 等）要么是 rgba()，
 * 要么是滚动条细节，塞进 <input type="color"> 只会让用户改出坏值。
 */
export const CUSTOM_THEME_TOKENS: { key: keyof ThemeColors; label: string }[] = [
  { key: 'canvas', label: '页面背景' },
  { key: 'layer', label: '卡片背景' },
  { key: 'fg', label: '正文文字' },
  { key: 'fg2', label: '次要文字' },
  { key: 'border', label: '边框' },
  { key: 'accent_soft', label: '强调浅底' },
]

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * 解析用户自定义的主题色覆盖（settings 里存的 JSON 串）。
 *
 * 只认白名单里的键 + #RRGGBB：这些值最终会被写进 CSS 变量，
 * 一个坏值会让某一处静默变成「看不见的文字」，所以在入口就丢掉。
 * 空串 / 坏 JSON 一律当「没有自定义」，回退到主题包原值。
 */
export function parseThemeOverrides(json: string | null | undefined): Partial<ThemeColors> {
  if (!json) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Partial<ThemeColors> = {}
  for (const { key } of CUSTOM_THEME_TOKENS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string' && HEX_COLOR.test(value.trim())) out[key] = value.trim()
  }
  return out
}

/** 主题包 + 用户覆盖之后的实际配色：应用主题与设置页显示当前值共用同一份计算。 */
export function effectiveThemeColors(
  packName: string,
  mode: 'light' | 'dark',
  overrides: Partial<ThemeColors> = {}
): ThemeColors {
  const pack = resolveThemePack(packName)
  return { ...(mode === 'dark' ? pack.dark : pack.light), ...overrides }
}

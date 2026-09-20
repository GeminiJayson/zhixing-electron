import { useEffect, useRef, useState } from 'react'
import { NOTIF_BLUE, type ArcRender, type DotRender } from '../vendor/bloub/bot/decor'
import { BotEngine, type BotFrame } from '../vendor/bloub/bot/engine'
import { DEMI_VIEWBOX, RAYON } from '../vendor/bloub/bot/repere'
import { SHAPE_BY_ID } from '../vendor/bloub/bot/skins'
import type { StateId } from '../vendor/bloub/bot/states'
import { PITCH_MAX, YAW_MAX } from '../vendor/bloub/gaze'

/**
 * bloub 引擎的 React 渲染层（vendor/bloub，MIT）。
 *
 * 上游那份渲染写在 BloubBot.vue 的模板里；这里逐段翻成 JSX，**不引入 Vue**。
 * 引擎本身与框架、与时钟都无关 —— sample(t) 是时间的纯函数 —— 所以这一层只做两件事：
 * 按时间取帧、把帧画出来。
 *
 * 每帧走一次 React state：这棵 SVG 只有几十个节点，开销可以忽略；
 * 换来的是「帧 = state」这种和引擎同样好推理的关系（不必手写 DOM 差分）。
 * 换成手改属性会在这里引入一套「元素池 + 数量变化」的复杂度，不值得。
 */
const VB = DEMI_VIEWBOX
const R = RAYON

/** 归一化的指针位置：球心为原点、半径为单位长度（-1 ~ 1）。 */
export interface BloubGaze {
  nx: number
  ny: number
}

interface Props {
  state: StateId
  /** null = 不跟随指针，由引擎自己保留漂移与眨眼 */
  gaze: BloubGaze | null
  /** 体型 id（shared/bloub 的 BLOUB_SHAPES）；认不出来时按「不覆盖」处理 */
  shape: string
}

/**
 * 一个点：默认是圆盘，但状态可以给它一个形状（「!」的墨滴不是圆）。
 * 带 d 字段时那个路径是以**球半径为单位**、以原点为中心的，所以要 translate/rotate/scale 摆上去。
 */
function dotNode(dot: DotRender, key: string): JSX.Element {
  // 颜色交给样式表（.bloub__ink 跟主题走），所以上游那套「按 depth 与底色混色」
  // 这里换算成等效的透明度：同样是从身体色向背景淡出，只是不必在 JS 里拿到具体色值。
  const opacity = dot.opacity * (dot.depth ?? 1)
  const move = `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`
  const tint = dot.color ? { fill: dot.color } : undefined
  return dot.d ? (
    <path key={key} className="bloub__ink" style={tint} opacity={opacity} d={dot.d} transform={move} />
  ) : (
    <circle key={key} className="bloub__ink" style={tint} opacity={opacity} cx={dot.x} cy={dot.y} r={dot.r} />
  )
}

export function BloubAvatar({ state, gaze, shape }: Props) {
  const [frame, setFrame] = useState<BotFrame | null>(null)
  const engineRef = useRef<BotEngine | null>(null)
  /** 引擎自己的时钟（秒）：它不收真实时间，只认这个累加值 */
  const clockRef = useRef(0)
  const gazeRef = useRef<BloubGaze | null>(gaze)
  gazeRef.current = gaze
  const uid = useRef(Math.random().toString(36).slice(2, 8)).current
  const maskId = `bloub-mask-${uid}`

  useEffect(() => {
    // shape / expression 传 null = 不覆盖，姿势由状态自己决定
    const engine = new BotEngine(R, state, null, null)
    engineRef.current = engine
    setFrame(engine.sample(0))
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      clockRef.current += (now - last) / 1000
      last = now
      const g = gazeRef.current
      engine.setLook(
        // yaw / pitch 是**绝对角度**（度）。mix=1 = 方向完全交给指针，wander=0 = 自动漂移让位；
        // 两个都交给引擎混合，因为只有它知道此刻的姿势
        g ? { yaw: g.nx * YAW_MAX, pitch: g.ny * PITCH_MAX, mix: 1, spin: 0, wander: 0 } : null,
        clockRef.current
      )
      setFrame(engine.sample(clockRef.current))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      engineRef.current = null
    }
    // 只在挂载时建一次：state 的变化走下面那个 effect。
    // 重建引擎会让动画从头开始，切状态时看起来像「闪一下」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 状态切换：把当前时刻交给引擎，让它从此刻开始过渡
  useEffect(() => {
    engineRef.current?.setState(state, clockRef.current)
  }, [state])

  // 换体型。注意上游的设计：自定义形状只在**基础体态**（idle / wink / wide / notify /
  // swirl）上生效，其余状态的轮廓本身就是动画 —— 所以换成三角之后切到 orbit，
  // 看到的仍是 orbit 自己的形状，这是对的，不是没生效。
  useEffect(() => {
    engineRef.current?.setShape(SHAPE_BY_ID.get(shape)?.radii ?? null, clockRef.current)
  }, [shape])

  const arcs: ArcRender[] = frame?.arcs ?? []
  const viewBox = `${-VB} ${-VB} ${VB * 2} ${VB * 2}`

  return (
    <svg
      className="bloub"
      viewBox={viewBox}
      role="img"
      aria-label="知行机器人"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* 眼睛是身体上真正的**洞**（和 x.ai 一样），不是盖在上面的白形状：
            这样它们滑到轮廓边缘时会自己裁切。 */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={-VB}
          y={-VB}
          width={VB * 2}
          height={VB * 2}
        >
          {frame && <path d={frame.bodyPath} fill="#fff" />}
          {frame?.eyes.map((eye, i) => (
            <path key={i} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />
          ))}
          {frame?.notch && (
            <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />
          )}
        </mask>

        {arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop key={i} offset={i / (arc.grad.stops.length - 1)} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* 环轨的后半段：画在身体之前，于是被身体挡住 */}
      <g fill="none" strokeLinecap="round">
        {arcs.map((arc) => (
          <path
            key={`b${arc.id}`}
            d={arc.back}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {/* 爆裂的粒子：从核后面过 */}
      {frame?.dotsBehind && (
        <g>{frame.dots.map((dot, i) => dotNode(dot, `pb${i}`))}</g>
      )}

      <g opacity={frame?.bodyAlpha ?? 1}>
        {/* 上游在这里先铺一层与身体轮廓一致的「纸」，用来遮住身后的环轨 ——
            眼睛既然是洞，透过去就会看见本该被身体挡住的东西。
            本项目的球浮在桌面上、只要那个形状本身，所以**不要这层纸**：
            眼睛直接透出桌面，看起来才是一个真正镂空的形状。
            代价是 orbit / burst 这类状态里，绕到球背面的环会从眼睛里露出来一点 ——
            球只有 96~160px，实测几乎看不出来，值得。 */}
        <g mask={`url(#${maskId})`}>
          <rect className="bloub__ink" x={-VB} y={-VB} width={VB * 2} height={VB * 2} />
        </g>
      </g>

      {frame && !frame.dotsBehind && (
        <g>{frame.dots.map((dot, i) => dotNode(dot, `pf${i}`))}</g>
      )}

      {frame?.notif && (
        <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />
      )}

      {/* 环轨的前半段 */}
      <g fill="none" strokeLinecap="round">
        {arcs.map((arc) => (
          <path
            key={`f${arc.id}`}
            d={arc.front}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  )
}

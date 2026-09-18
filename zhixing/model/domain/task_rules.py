# -*- coding: utf-8 -*-
"""任务业务规则：循环推进、打卡重置、自然语言日期、聚合统计。"""
import calendar
import re
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from .entities import RepeatPeriod, Task, TaskStatus

_WEEKDAY_CN = {"周一": 0, "周二": 1, "周三": 2, "周四": 3, "周五": 4, "周六": 5, "周日": 6, "周天": 6}

_FREQ_VALUES = {"DAILY": RepeatPeriod.DAILY, "WEEKLY": RepeatPeriod.WEEKLY,
               "MONTHLY": RepeatPeriod.MONTHLY}


def parse_rrule(rule: Optional[str]) -> Optional[Dict[str, object]]:
    """解析自定义 RRULE 子集（RFC5545 简化）：FREQ/INTERVAL/COUNT/UNTIL。

    返回 {'freq': RepeatPeriod, 'interval': int, 'count': Optional[int],
          'until': Optional[date]}；空串/非法输入返回 None。
    """
    if not rule or not str(rule).strip():
        return None
    info: Dict[str, object] = {"freq": RepeatPeriod.DAILY, "interval": 1,
                               "count": None, "until": None}
    for part in str(rule).strip().split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, _, value = part.partition("=")
        key, value = key.strip().upper(), value.strip()
        if key == "FREQ":
            info["freq"] = _FREQ_VALUES.get(value.upper(), RepeatPeriod.DAILY)
        elif key == "INTERVAL":
            try:
                info["interval"] = max(1, int(value))
            except (TypeError, ValueError):
                pass
        elif key == "COUNT":
            try:
                info["count"] = max(0, int(value))
            except (TypeError, ValueError):
                pass
        elif key == "UNTIL":
            until = _parse_until(value)
            if until is not None:
                info["until"] = until
    return info


def _parse_until(value: str) -> Optional[date]:
    v = (value or "").upper().strip()
    if "T" in v:
        v = v.split("T", 1)[0]
    v = v.rstrip("Z")
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def _step(d: date, freq: RepeatPeriod, interval: int) -> date:
    """按 freq + interval 推进（interval>=1）。"""
    if freq == RepeatPeriod.DAILY:
        return d + timedelta(days=interval)
    if freq == RepeatPeriod.WEEKLY:
        return d + timedelta(weeks=interval)
    if freq == RepeatPeriod.MONTHLY:
        total = d.month - 1 + interval
        y2, m2 = d.year + total // 12, total % 12 + 1
        day = min(d.day, calendar.monthrange(y2, m2)[1])
        return date(y2, m2, day)
    return d


def next_due(d: date, period: RepeatPeriod, rule: Optional[str] = None) -> Optional[date]:
    """按周期推进一天；自定义规则支持 interval/until（until 超限返回 None）。"""
    if period == RepeatPeriod.CUSTOM:
        info = parse_rrule(rule)
        if info is None:
            return d
        nd = _step(d, info["freq"], int(info["interval"]))
        if info["until"] is not None and nd > info["until"]:
            return None
        return nd
    if period == RepeatPeriod.DAILY:
        return d + timedelta(days=1)
    if period == RepeatPeriod.WEEKLY:
        return d + timedelta(weeks=1)
    if period == RepeatPeriod.MONTHLY:
        y, m = d.year, d.month
        m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
        day = min(d.day, calendar.monthrange(y2, m2)[1])
        return date(y2, m2, day)
    return d


def next_count_rule(rule: Optional[str]) -> Optional[str]:
    """克隆时 COUNT 递减：无 COUNT → 原样返回；COUNT<=1 → None（终止）。"""
    info = parse_rrule(rule)
    if info is None or info["count"] is None:
        return rule
    if info["count"] <= 1:
        return None
    parts = []
    for part in (str(rule) or "").split(";"):
        if part.strip().upper().startswith("COUNT="):
            parts.append(f"COUNT={info['count'] - 1}")
        else:
            parts.append(part)
    return ";".join(parts)


def advance_recurrence(task: Task) -> Optional[date]:
    """循环任务（父级）完成时克隆推进：返回新的截止日期。"""
    if not task.is_recurring:
        return None
    base = task.due_date or date.today()
    return next_due(base, task.repeat_period, task.repeat_rule)


def next_recurrence(task: Task) -> Tuple[Optional[date], Optional[str]]:
    """克隆推进：返回 (下一截止日, 克隆应携带的 repeat_rule)。

    until 超限或 COUNT 耗尽时返回 (None, None)（终止循环）。
    """
    if not task.is_recurring:
        return None, None
    base = task.due_date or date.today()
    nd = next_due(base, task.repeat_period, task.repeat_rule)
    if nd is None:
        return None, None
    if task.repeat_period == RepeatPeriod.CUSTOM:
        rule = next_count_rule(task.repeat_rule)
        if rule is None:
            return None, None
        return nd, rule
    return nd, task.repeat_rule


def roll_recurring_subtasks(tasks: List[Task], today: date) -> List[int]:
    """循环子任务打卡重置：到期未勾选则跳过；到期已完成/上次重置日早于今日则重置为待办。

    返回被重置的 task_id 列表。调用方负责持久化并累计 streak。
    """
    reset_ids = []
    for t in tasks:
        if not t.is_recurring or t.parent_id is None:
            continue
        if t.last_reset_date is not None and t.last_reset_date >= today:
            continue
        period = t.repeat_period
        base = t.last_reset_date or t.due_date or (today - timedelta(days=1))
        if period == RepeatPeriod.CUSTOM:
            due = next_due(base, period, t.repeat_rule)
        elif period != RepeatPeriod.DAILY:
            due = next_due(base, period)
        else:
            due = base + timedelta(days=1)
        if due is None:
            continue
        if due <= today:
            t.status = TaskStatus.TODO
            t.last_reset_date = today
            t.due_date = today
            reset_ids.append(t.id)
    return reset_ids


_DATE_PATTERNS = [
    (re.compile(r"^今天$"), lambda t: t),
    (re.compile(r"^明天$"), lambda t: t + timedelta(days=1)),
    (re.compile(r"^后天$"), lambda t: t + timedelta(days=2)),
    (re.compile(r"^大后天$"), lambda t: t + timedelta(days=3)),
]

# P0-2: 时刻解析
_TIME_PATTERNS = [
    # 中文：下午3点 / 3点半 / 3点45分 / 晚上8点（时段词可为空）
    re.compile(r"^(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2})点(半|(\d{1,2})分)?$"),
    # 24h 制：14:30 / 9:05
    re.compile(r"^(\d{1,2}):(\d{2})$"),
]


def _resolve_hour(daypart: str, hour: int) -> Optional[int]:
    """口语时刻 → 24h。无修饰时 1-6 点按口语「下午/晚间」处理（如 3点=15:00）。"""
    if hour > 23:
        return None
    if daypart == "凌晨":
        return hour if hour <= 6 else hour      # 凌晨多指 0-6
    if daypart in ("早上", "上午"):
        return hour                             # 上午/早上按字面（≤12）
    if daypart == "中午":
        return 12 + hour if hour < 12 else hour
    if daypart in ("下午", "傍晚", "晚上", "夜里", "夜晚"):
        return 12 + hour if hour < 12 else (12 if hour == 12 else hour)
    return hour + 12 if 1 <= hour <= 6 else hour   # 无修饰


def parse_clock(text: str) -> Optional[Tuple[int, int]]:
    """解析纯时刻短语 → (hour, minute)。支持：14:30 / 3点 / 3点半 / 3点45分 / 下午5点 / 晚上8点。"""
    text = (text or "").strip()
    if not text:
        return None
    m = _TIME_PATTERNS[1].match(text)          # 24h
    if m:
        try:
            h, mi = int(m.group(1)), int(m.group(2))
        except ValueError:
            return None
        return (h, mi) if 0 <= h < 24 and 0 <= mi < 60 else None
    m = _TIME_PATTERNS[0].match(text)          # 中文
    if not m:
        return None
    daypart = m.group(1) or ""
    try:
        h = int(m.group(2))
    except ValueError:
        return None
    minute = 30 if m.group(3) == "半" else (int(m.group(4)) if m.group(4) else 0)
    hour = _resolve_hour(daypart, h)
    return (hour, minute) if hour is not None and 0 <= minute < 60 else None


def parse_natural_datetime(text: str, today: Optional[date] = None) -> Optional[Tuple[date, Optional[Tuple[int, int]]]]:
    """解析「日期 + 可选时刻」短语 → (date, (hour, minute)|None)。

    支持：今天 / 明天 / 周五 / 9月10日 / 明天3点 / 明天下午3点半 / 明天 14:30 / 周五前。
    返回 (due_date, clock) —— clock 供调用方设 reminder_at；纯日期时 clock=None。
    """
    text = (text or "").strip()
    if not text:
        return None
    # 时间在前置的「前/之前/以前」不影响结果（如「明天前」仍是明天）；先剥离
    cleaned = re.sub(r"^(前|之前|以前|之内|内)(?=\s|$)", "", text).strip()
    # 拆「日期词 + 时刻词」：中文时刻紧跟日期，或空格 + HH:MM
    m = re.search(r"(今天|明天|后天|大后天|周[一二三四五六日天]|下周[一二三四五六日天]|"
                  r"\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2})"
                  r"\s*((?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?\d{1,2}点(?:半|\d{1,2}分)?|\d{1,2}:\d{2})?",
                  cleaned)
    if not m:
        return None
    d = parse_natural_date(m.group(1), today=today)
    if d is None:
        return None
    clock = parse_clock(m.group(2)) if m.group(2) else None
    return (d, clock)


def parse_natural_date(text: str, today: Optional[date] = None) -> Optional[date]:
    """解析快速输入中的日期词：今天/明天/后天/周X/大后天/下周一/MM-DD。"""
    text = (text or "").strip()
    if not text:
        return None
    t = today or date.today()
    for pat, fn in _DATE_PATTERNS:
        if pat.match(text):
            return fn(t)
    if text in _WEEKDAY_CN:
        delta = (_WEEKDAY_CN[text] - t.weekday()) % 7
        return t + timedelta(days=delta)
    m = re.match(r"^下周([一二三四五六日天])$", text)
    if m:
        wd = _WEEKDAY_CN["周" + m.group(1)]
        delta = (wd - t.weekday()) % 7 or 7
        return t + timedelta(days=delta + 7 if delta == 0 else delta)
    m = re.match(r"^(\d{1,2})月(\d{1,2})[日号]?$", text)
    if m:
        try:
            d = date(t.year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
        return d if d >= t else date(t.year + 1, d.month, d.day)
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})$", text)
    if m:
        try:
            d = date(t.year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
        return d if d >= t else date(t.year + 1, d.month, d.day)
    return None


def subtask_progress(children: List[Task]) -> Tuple[int, int]:
    done = sum(1 for c in children if c.status == TaskStatus.DONE)
    return done, len(children)


def effective_done_map(tasks: List[Task]) -> Dict[int, bool]:
    """有效完成 roll-up：叶子看自身 status==DONE；父任务看所有后代是否都有效完成。

    纯派生值（不落库）：只读计算，供今日待办 / 逾期 / 统计 / 视图勾选态共用。
    同时兼容「树形（children 已挂载）」与「扁平（children 为空）」两种输入。
    """
    all_tasks: List[Task] = []
    seen_ids = set()

    def collect(items):
        for t in items or []:
            if t.id is not None:
                if t.id in seen_ids:
                    continue
                seen_ids.add(t.id)
            all_tasks.append(t)
            collect(getattr(t, "children", []) or [])

    collect(tasks)

    children_map: Dict[Optional[int], List[Task]] = {}
    for t in all_tasks:
        children_map.setdefault(t.parent_id, []).append(t)

    memo: Dict[int, bool] = {}

    def rec(t: Task) -> bool:
        key = t.id
        if key is not None and key in memo:
            return memo[key]
        if key is None:
            kids = list(getattr(t, "children", []) or [])
        else:
            kids = children_map.get(key) or []
        # 「完成」与「放弃」都是终态，视为有效完成（与 entities.Task.is_done 一致）
        result = (t.status in (TaskStatus.DONE, TaskStatus.ABANDONED)) if not kids else all(rec(c) for c in kids)
        if key is not None:
            memo[key] = result
        return result

    for t in all_tasks:
        rec(t)
    return {t.id: memo[t.id] for t in all_tasks if t.id is not None}


def today_roots(tasks: List[Task], today: Optional[date] = None,
                effective: Optional[Dict[int, bool]] = None) -> List[Task]:
    """今日待办根集合：顶层 + 有效未完成 + 未逾期（无截止 或 截止>=今天）。"""
    today = today or date.today()
    eff = effective if effective is not None else effective_done_map(tasks)
    return [t for t in tasks
            if t.parent_id is None
            and not eff.get(t.id, t.status in (TaskStatus.DONE, TaskStatus.ABANDONED))
            and (t.due_date is None or t.due_date >= today)]


def sort_tasks(parent_first: bool = True):
    """列表排序键：保持父在子前、按 sort_key。"""

    def key(t: Task):
        depth = 0
        p = t.parent_id
        while p is not None and depth < 8:  # 展平层级供界面排序
            depth += 1
            p = None  # 仓储层负责真实树；此处仅做稳定排序
        return (depth, t.sort_key, t.id or 0)

    return key

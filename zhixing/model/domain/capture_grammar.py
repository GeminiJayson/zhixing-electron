# -*- coding: utf-8 -*-
"""快速捕获语法糖解析：!优先级 @列表 #标签 日期词（P0-2 起支持「明天3点」带时刻）。

示例：``周五前 交付方案 !2 @工作 #客户`` → 标题「交付方案」、优先级高、
列表「工作」、标签「客户」、截止=本周五。
示例：``明天3点 交周报`` → due_word「明天3点」，due_clock=(15,0)（调用方设 reminder_at）。
"""
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .task_rules import parse_natural_date, parse_natural_datetime
from .entities import Priority

_PRIORITY_TOKEN = {"!1": Priority.P8, "!2": Priority.P5, "!3": Priority.P2,
                   "!!!": Priority.P8, "!!": Priority.P5, "!": Priority.P2}
# v0.17 语义：老快捷按「数字/叹号越少=越高」保留（!1=最高 P8、!2=中 P5、!3=低 P2）；
# 8 级全档位（P1..P8）在任务编辑/行内菜单中可选。
# 日期词 + 可选紧跟时刻（中文「3点/点半/分」或 24h「14:30」，空格可隔开）；时刻为 group(2)
_TIME_SUFFIX = r"(\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?\d{1,2}点(?:半|\d{1,2}分)?|\s*\d{1,2}:\d{2})?"
_DATE_WORDS = r"(今天|明天|后天|大后天|下下周?[一二三四五六日天]|周[一二三四五六日天]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2})" + _TIME_SUFFIX


@dataclass
class ParsedCapture:
    title: str = ""
    priority: Priority = Priority.NONE
    list_name: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    due_word: Optional[str] = None      # 原始日期短语（可能含时刻：明天3点）
    due_clock: Optional[Tuple[int, int]] = None   # P0-2: (hour, minute)，纯日期为 None
    today = None

    @property
    def has_meta(self) -> bool:
        return bool(self.priority != Priority.NONE or self.list_name or self.tags or self.due_word)


def parse(text: str, today=None) -> ParsedCapture:
    """解析一行快速输入。语法糖 token 会被从标题中剔除。"""
    result = ParsedCapture()
    result.today = today
    text = (text or "").strip()
    if not text:
        return result

    # 日期（含可选时刻：明天3点 / 周五 14:30）——可出现在任意位置
    m = re.search(_DATE_WORDS, text)
    if m:
        # group(1)=日期词、group(2)=可选时刻（明天3点 → 「明天」+「3点」）
        due_word = (m.group(1) + (m.group(2) or ""))
        result.due_word = due_word
        dt = parse_natural_datetime(due_word, today=today)
        if dt:
            _, result.due_clock = dt

    def strip_token(t: str) -> str:
        nonlocal text
        text = text.replace(t, " ", 1).strip()

    # 优先级
    for token in ("!!!", "!!", "!1", "!2", "!3"):
        if text.startswith(token + " ") or (token in text and token.startswith("!") and len(token) == 2):
            if re.search(r"(^|\s)" + re.escape(token) + r"(\s|$)", text):
                result.priority = _PRIORITY_TOKEN[token]
                strip_token(token)
                break
    m = re.search(r"(^|\s)!(\s)($|\s)", text)
    if result.priority == Priority.NONE and m:
        result.priority = Priority.LOW
        text = re.sub(r"(^|\s)!(\s)($|\s)", " ", text, count=1).strip()

    # @列表（允许中文）
    m = re.search(r"(^|\s)@([\w\u4e00-\u9fff\-]+)", text)
    if m:
        result.list_name = m.group(2)
        text = text.replace(m.group(0), " ", 1).strip()

    # #标签
    for m in re.finditer(r"(^|\s)#([\w\u4e00-\u9fff\-]+)", text):
        result.tags.append(m.group(2))
    if result.tags:
        text = re.sub(r"(^|\s)#[\w\u4e00-\u9fff\-]+", " ", text).strip()

    if result.due_word:
        text = re.sub(_DATE_WORDS, " ", text, count=1).strip()
        # 「周五前/明天之内」等修饰词残留清理
        text = re.sub(r"^(前|之前|以前|之内|内)(?=\s|$)", " ", text).strip()
        text = re.sub(r"(?<=\S)(前|之前|以前)$", " ", text).strip()
        text = re.sub(r"\s{2,}", " ", text).strip(" -，,")

    text = re.sub(r"\s{2,}", " ", text).strip(" -，,")
    result.title = text
    return result


def due_from_word(word: Optional[str], today=None):
    """日期短语 → date（纯日期或含时刻的短语均取日期部分；P0-2 兼容「明天3点」）。"""
    if not word:
        return None
    dt = parse_natural_datetime(word, today=today)
    return dt[0] if dt else None

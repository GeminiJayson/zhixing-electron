# -*- coding: utf-8 -*-
"""深链 `zhixing://` 解析与分发（v0.15 P1-4）。

支持路由：
  zhixing://task/<id>                  → 打开任务编辑
  zhixing://note/<id>                  → 打开笔记
  zhixing://note/<id>?block=<key>      → 打开笔记并定位段落（P0-1 block_key）
  zhixing://flash/<id>                 → 跳收件箱闪念
  zhixing://folder/<id>                → 定位笔记文件夹

设计约束：本模块保持纯函数（无 Qt 依赖）便于单测；argv/URL 提取与 IPC 转发
在 __main__.py / AppController 侧接线。系统协议注册（macOS Info.plist
CFBundleURLTypes、Windows 注册表）属打包工程，见 docs/03 与打包说明。
"""
import re
import urllib.parse
from typing import Dict, Optional

SCHEME = "zhixing"


def parse_url(url: str) -> Optional[Dict[str, object]]:
    """解析 zhixing:// URI → {'kind','id','block'}；非本协议/无法解析返回 None。"""
    u = (url or "").strip()
    if not u.lower().startswith("zhixing:"):
        return None
    if u.lower().startswith("zhixing://"):
        u = u[len("zhixing://"):]
    elif u.lower().startswith("zhixing:"):
        u = u[len("zhixing:"):]
    u = u.lstrip("/")
    # 兼容 web 风格 /note/12 与紧凑 note/12
    m = re.match(r"^(task|note|flash|folder)/(\d+)(?:\?(.*))?$", u)
    if not m:
        m = re.match(r"^(task|note|flash|folder)/(\d+)$", u)
    if not m:
        return None
    kind, raw_id = m.group(1), m.group(2)
    try:
        nid = int(raw_id)
    except ValueError:
        return None
    if nid <= 0:
        return None
    block = ""
    q = m.group(3)
    if q:
        qs = urllib.parse.parse_qs(q)
        block = (qs.get("block") or [""])[0]
    return {"kind": kind, "id": nid, "block": block}


def extract_argv(argv) -> Optional[str]:
    """从进程 argv 提取深链 URL（首个 zhixing:// 参数）。"""
    for a in argv or []:
        if isinstance(a, str) and a.lower().startswith("zhixing:"):
            return a
    return None

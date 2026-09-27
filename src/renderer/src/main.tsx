import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WidgetApp } from './WidgetApp'
import { DialogProvider } from './components/Dialogs'
import { ConditionApp } from './ConditionApp'
import { CaptureWindowApp } from './CaptureWindowApp'
import { ReminderApp } from './ReminderApp'
import { PomodoroWindowApp } from './PomodoroWindowApp'
import './styles/tokens.css'
import './styles/global.css'
import './styles/widget.css'
import './styles/reminder.css'

// 三份产物共用一个入口，用 query 分流：主窗口 / 桌面浮窗 / 工作流条件的独立确认窗
const params = new URLSearchParams(window.location.search)
const isWidget = params.get('widget') === '1'
const isCondition = params.get('condition') === '1'
const isCapture = params.get('capture') === '1'
const isReminder = params.get('reminder') === '1'
const isPomodoro = params.get('pomodoro') === '1'
document.documentElement.dataset.surface = isCondition
  ? 'condition'
  : isCapture
    ? 'capture'
    : isPomodoro
      ? 'pomodoro'
      : isReminder
        ? 'reminder'
        : isWidget
          ? 'widget'
          : 'main'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isCondition ? (
      <ConditionApp />
    ) : isPomodoro ? (
      // 番茄钟：独立小窗，卡片与捕获窗/条件窗共用同一套 .modal 骨架
      <PomodoroWindowApp />
    ) : isCapture ? (
      <DialogProvider>
        <CaptureWindowApp />
      </DialogProvider>
    ) : isWidget ? (
      // 浮窗与主窗口共用同一套应用内对话框（主窗口的 Provider 在 App 里，浮窗没有它）
      <DialogProvider>
        <WidgetApp />
      </DialogProvider>
    ) : isReminder ? (
      // 提醒气泡：透明小窗，挂在悬浮表情旁边（消费已收归主进程，这里只显示）
      <ReminderApp />
    ) : (
      <App />
    )}
  </React.StrictMode>
)

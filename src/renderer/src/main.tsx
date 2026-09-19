import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WidgetApp } from './WidgetApp'
import { DialogProvider } from './components/Dialogs'
import { ConditionApp } from './ConditionApp'
import { CaptureWindowApp } from './CaptureWindowApp'
import './styles/tokens.css'
import './styles/global.css'
import './styles/widget.css'

// 三份产物共用一个入口，用 query 分流：主窗口 / 桌面浮窗 / 工作流条件的独立确认窗
const params = new URLSearchParams(window.location.search)
const isWidget = params.get('widget') === '1'
const isCondition = params.get('condition') === '1'
const isCapture = params.get('capture') === '1'
document.documentElement.dataset.surface = isCondition
  ? 'condition'
  : isCapture
    ? 'capture'
    : isWidget
      ? 'widget'
      : 'main'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isCondition ? (
      <ConditionApp />
    ) : isCapture ? (
      <DialogProvider>
        <CaptureWindowApp />
      </DialogProvider>
    ) : isWidget ? (
      // 浮窗与主窗口共用同一套应用内对话框（主窗口的 Provider 在 App 里，浮窗没有它）
      <DialogProvider>
        <WidgetApp />
      </DialogProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
)

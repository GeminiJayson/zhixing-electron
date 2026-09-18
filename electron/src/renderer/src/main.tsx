import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WidgetApp } from './WidgetApp'
import './styles/tokens.css'
import './styles/global.css'
import './styles/widget.css'

// 桌面浮窗与主窗口共用同一份产物，用 ?widget=1 分流
const isWidget = new URLSearchParams(window.location.search).get('widget') === '1'
document.documentElement.dataset.surface = isWidget ? 'widget' : 'main'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isWidget ? <WidgetApp /> : <App />}</React.StrictMode>
)

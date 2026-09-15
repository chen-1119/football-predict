import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/matchday-shell.css'
import './styles/operational-refresh.css'
import App from './App.tsx'
import { OperationalStatusDock } from './components/OperationalStatusDock'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <OperationalStatusDock />
  </StrictMode>,
)

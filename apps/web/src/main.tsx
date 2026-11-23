// 本文件所有改动要求遵循 agent-rules 规范
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found');
}

const routerBaseName = import.meta.env.BASE_URL.replace(/\/$/, '');

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: '#1f883d',
          colorLink: '#0969da',
          colorError: '#cf222e',
          borderRadius: 6,
          fontSize: 14,
        },
      }}
    >
      <BrowserRouter {...(routerBaseName.length > 0 ? { basename: routerBaseName } : {})}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  </StrictMode>,
);

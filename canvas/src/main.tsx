import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);

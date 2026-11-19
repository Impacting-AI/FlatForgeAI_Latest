import React from 'react';
import { createRoot } from 'react-dom/client';
import FlatForge from '../components/flatforge/FlatForge';
import LoginGate from '../components/flatforge/LoginGate';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><LoginGate><FlatForge/></LoginGate></React.StrictMode>);

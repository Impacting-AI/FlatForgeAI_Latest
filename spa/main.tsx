import React from 'react';
import { createRoot } from 'react-dom/client';
import FlatForge from '../components/flatforge/FlatForge';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><FlatForge/></React.StrictMode>);

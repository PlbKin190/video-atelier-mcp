import { mount } from 'svelte';
import App from './App.svelte';
import './theme.css';

const target = document.getElementById('app');
if (!target) throw new Error('Host element #app not found.');
mount(App, { target });

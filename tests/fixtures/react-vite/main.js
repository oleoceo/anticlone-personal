import React from 'react';
import {createRoot} from 'react-dom/client';
function App(){
 const [route,setRoute]=React.useState('initial');
 return React.createElement('main',null,
  React.createElement('h1',null,'React controlled SPA'),
  React.createElement('button',{onClick:()=>{history.pushState({},'', '/react/next');setRoute('next');}},'SPA transition'),
  React.createElement('p',null,route),
  route==='next'&&React.createElement('a',{href:'/checkout'},'Dynamic native checkout'));
}
createRoot(document.getElementById('root')).render(React.createElement(App));

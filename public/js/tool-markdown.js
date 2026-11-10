(function(root){
  // Display-only Markdown: create safe DOM nodes, never interpret model HTML.
  function render(value){
    const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
    function inline(node,text){
      const tokens=/`([^`\n]+)`|\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~\n]+)~~|(https:\/\/[^\s<>"|)]+)/g;let match,from=0;
      while((match=tokens.exec(text))){node.append(document.createTextNode(text.slice(from,match.index)));from=tokens.lastIndex;
        if(match[1]){node.append(el('code',match[1]));continue;}
        if(match[4]||match[5]){node.append(el('strong',match[4]||match[5]));continue;}
        if(match[6]||match[7]){node.append(el('em',match[6]||match[7]));continue;}
        if(match[8]){node.append(el('del',match[8]));continue;}
        try{const url=new URL(match[3]||match[9]);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe URL');
          const a=el('a',match[2]||match[9]);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';node.append(a);
        }catch(_){node.append(document.createTextNode(match[0]));}
      }node.append(document.createTextNode(text.slice(from)));
    }
    const host=el('div');host.className='tool-markdown';const lines=String(value||'').replace(/\r/g,'').split('\n');
    const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim().replace(/\\\|/g,'|'));
    const listItem=line=>line.match(/^(\s*)(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/);
    for(let i=0;i<lines.length;i++){
      const text=lines[i].trim();if(!text)continue;
      const fence=text.match(/^(`{3,}|~{3,})(.*)$/);
      if(fence){const code=el('code'),pre=el('pre'),body=[];const close=new RegExp('^'+fence[1][0]+'{'+fence[1].length+',}\\s*$');while(i+1<lines.length){const next=lines[++i];if(close.test(next.trim()))break;body.push(next);}code.textContent=body.join('\n');pre.append(code);host.append(pre);continue;}
      if(/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)){host.append(el('hr'));continue;}
      if(i+1<lines.length && text.includes('|') && cells(lines[i+1]).length>=2 && cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
        const wrap=el('div');wrap.className='tool-answer-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','回答の比較表');
        const table=el('table'),head=el('thead'),row=el('tr');const headers=cells(text);
        for(const title of headers){const th=el('th');th.setAttribute('scope','col');inline(th,title);row.append(th);}head.append(row);table.append(head);const body=el('tbody');i++;
        while(i+1<lines.length&&lines[i+1].trim().includes('|')){const values=cells(lines[++i]),tr=el('tr');for(let j=0;j<headers.length;j++){const td=el('td');inline(td,values[j]||'');tr.append(td);}body.append(tr);}
        table.append(body);wrap.append(table);host.append(wrap);continue;
      }
      if(listItem(lines[i])){const stack=[];while(i<lines.length){const match=listItem(lines[i]);if(!match){i--;break;}const indent=match[1].replace(/\t/g,'    ').length,tag=match[3]?'ol':'ul';
          while(stack.length&&stack.at(-1).indent>indent)stack.pop();
          if(stack.length&&stack.at(-1).indent===indent&&stack.at(-1).tag!==tag)stack.pop();
          if(!stack.length||stack.at(-1).indent<indent){const list=el(tag);if(tag==='ol')list.setAttribute('start',match[3]);(stack.length?stack.at(-1).item:host).append(list);stack.push({indent,tag,list});}
          const item=el('li');inline(item,match[4]);stack.at(-1).list.append(item);stack.at(-1).item=item;
          if(i+1>=lines.length)break;i++;
        }continue;}
      if(/^>\s?/.test(text)){const quote=el('blockquote');inline(quote,text.replace(/^>\s?/,''));host.append(quote);continue;}
      const heading=text.match(/^(#{1,6})\s+(.+)/);
      const node=el(heading?'h'+Math.min(6,heading[1].length+1):'p');inline(node,heading?heading[2]:text);host.append(node);
    }return host;
  }
  if(root)root.ToolMarkdown={render};
})(typeof window==='undefined'?null:window);

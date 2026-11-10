(function(root){
  // Small display-only Markdown subset. Model output is never inserted as HTML.
  function render(value){
    const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
    function inline(node,text){
      const tokens=/\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|(https:\/\/[^\s<>"|)]+)/g;let match,from=0;
      while((match=tokens.exec(text))){node.append(document.createTextNode(text.slice(from,match.index)));from=tokens.lastIndex;
        if(match[3]){node.append(el('strong',match[3]));continue;}
        try{const url=new URL(match[2]||match[4]);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe URL');
          const a=el('a',match[1]||match[4]);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';node.append(a);
        }catch(_){node.append(document.createTextNode(match[0]));}
      }node.append(document.createTextNode(text.slice(from)));
    }
    const host=el('div');host.className='tool-markdown';const lines=String(value||'').replace(/\r/g,'').split('\n');
    const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim().replace(/\\\|/g,'|'));
    for(let i=0;i<lines.length;i++){
      const text=lines[i].trim();if(!text)continue;
      if(i+1<lines.length && text.includes('|') && cells(lines[i+1]).length>=2 && cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
        const wrap=el('div');wrap.className='tool-answer-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','商品候補などの比較表');
        const table=el('table'),head=el('thead'),row=el('tr');const headers=cells(text);
        for(const title of headers){const th=el('th');th.setAttribute('scope','col');inline(th,title);row.append(th);}head.append(row);table.append(head);const body=el('tbody');i++;
        while(i+1<lines.length&&lines[i+1].trim().includes('|')){const values=cells(lines[++i]),tr=el('tr');for(let j=0;j<headers.length;j++){const td=el('td');inline(td,values[j]||'');tr.append(td);}body.append(tr);}
        table.append(body);wrap.append(table);host.append(wrap);continue;
      }
      const heading=text.match(/^#{1,6}\s+(.+)/),bullet=text.match(/^[-*]\s+(.+)/);
      if(bullet){const list=el('ul');let line=text;while(true){const item=el('li');inline(item,line.replace(/^[-*]\s+/,''));list.append(item);if(i+1>=lines.length||!/^[-*]\s+/.test(lines[i+1].trim()))break;line=lines[++i].trim();}host.append(list);continue;}
      const node=el(heading?'h3':'p');inline(node,heading?heading[1]:text);host.append(node);
    }return host;
  }
  if(root)root.ToolMarkdown={render};
})(typeof window==='undefined'?null:window);

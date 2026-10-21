import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {webuiUrl,webuiSkip,listFiles} from './webui-source.mjs';
import {matchesFilter,validateFilter,filterTypes,supportsFilterOperator,withFilterValues,sqlLike} from '../src/webui/filters.mjs';
import {connection,BrowserBackend} from '../src/webui/backend.mjs';
import {MemoryStore} from '../src/core.mjs';
import {parityCases,scalarOperators,stringOperators} from './filter-parity-cases.mjs';
const cases=parityCases();
const fields={String:['Manga','author'],Int:['Manga','id'],Long:['Manga','sourceId'],Double:['Chapter','chapterNumber'],Boolean:['Chapter','isRead'],MangaStatus:['Manga','status'],ContentWarning:['Source','contentWarning']};
test('293-row parity table uses actual desktop FilterKt/Exposed/H2 results, including Chapter Float conversion',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./filter-desktop-parity.json',import.meta.url)));
  assert.equal(createHash('sha256').update(JSON.stringify(cases)).digest('hex'),oracle.caseSha256,'Cases changed: rerun the desktop oracle, do not invent expected rows');
  assert.equal(cases.length,oracle.masks.length);
  for(let i=0;i<cases.length;i++){
    const c=cases[i],[type,field]=fields[c.type];
    const actual=connection(type,c.values.map((value,index)=>({id:index,[field]:value})),{filter:{[field]:c.filter}}).nodes;
    const mask=c.values.reduce((mask,value,index)=>matchesFilter({[field]:value},{[field]:c.filter},type)?mask|(1<<index):mask,0);
    assert.equal(mask,oracle.masks[i],c.id);
    assert.equal(actual.length,c.values.filter((_,index)=>oracle.masks[i]&(1<<index)).length,c.id+' connection');
  }
});
test('every generated WebUI scalar and object filter input is covered; schema changes fail this audit',{skip:webuiSkip},async()=>{
  const schema=await readFile(new URL('src/lib/graphql/generated/graphql-base.types.ts',webuiUrl),'utf8');
  const names=[];
  for(const match of schema.matchAll(/export type (\w+)FilterInput = \{([\s\S]*?)\n\};/g)){
    const [,type,body]=match;names.push(type);
    const members=[...body.matchAll(/    (\w+)\?: InputMaybe<(.+)>;/g)];
    if(fields[type]){
      const expected=new Set(type==='String'?stringOperators:scalarOperators);
      assert.deepEqual(new Set(members.map(m=>m[1])),expected,type);
      for(const operation of expected)assert.equal(supportsFilterOperator(type,operation),true,type+'.'+operation);
    }else{
      assert.ok(filterTypes[type],'Unclassified schema filter '+type);
      assert.deepEqual(Object.fromEntries(members.filter(m=>!['and','or','not'].includes(m[1])).map(m=>[m[1],m[2].replace(/FilterInput$/,'')])),filterTypes[type]);
      for(const member of members.filter(m=>['and','or','not'].includes(m[1])))assert.ok(member[2].includes(type+'FilterInput'));
    }
  }
  assert.equal(names.length,15);
});
test('unknown fields/operators and invalid typed operands reject even an empty collection',()=>{
  for(const [type,sample] of Object.entries(filterTypes)){
    const [field,scalar]=Object.entries(sample)[0];
    for(const operation of ['regex','likeIgnoreCase','between','equalToInsensitive'])assert.throws(()=>connection(type,[],{filter:{[field]:{[operation]:'x'}}}),/Unsupported/);
    assert.throws(()=>connection(type,[],{filter:{unknown:{equalTo:1}}}),/Unsupported/);
    assert.throws(()=>connection(type,[],{filter:{and:{}}}),/array/);
    assert.throws(()=>connection(type,[],{filter:{or:[null]}}),/array/);
    assert.throws(()=>connection(type,[],{filter:{[field]:{in:[null]}}}),/non-null/);
  }
  for(const [field,value] of [['id',1.5],['sourceId','9223372036854775808'],['inLibrary','true'],['status','INVALID']])assert.throws(()=>validateFilter({[field]:{equalTo:value}},'Manga'));
  assert.throws(()=>validateFilter({author:{like:123}},'Manga'),/string/);
});
test('SQL UNKNOWN survives NOT; desktop OR combines with preceding fields, empty clauses are omitted',()=>{
  const rows=[{id:1,author:null},{id:2,author:'Alpha'},{id:3,author:'beta'}];
  const ids=filter=>connection('Manga',rows,{filter}).nodes.map(row=>row.id);
  assert.deepEqual(ids({not:{author:{equalTo:'Alpha'}}}),[3]);
  assert.deepEqual(ids({id:{equalTo:1},or:[{id:{equalTo:3}}]}),[1,3]);
  assert.deepEqual(ids({or:[]}),[1,2,3]);assert.deepEqual(ids({not:{}}),[1,2,3]);
  assert.deepEqual(ids({not:{author:{like:'bad\\'}}}),[]);
});
test('LIKE handles many wildcard segments without exponential regex backtracking',()=>{
  assert.equal(sqlLike('a'.repeat(20000),('%a').repeat(40)+'b'),false);
  assert.equal(sqlLike('x\ny','x_y'),true);
  assert.equal(sqlLike('😀','_'),false);assert.equal(sqlLike('😀','__'),true);
});
test('category joins evaluate the complete filter against one joined category row',()=>{
  const rows=[{id:1,categoryIds:[1,2]},{id:2,categoryIds:[0]}];
  assert.equal(connection('Manga',rows,{filter:{categoryId:{equalTo:1},and:[{categoryId:{equalTo:2}}]}}).totalCount,0);
  assert.equal(connection('Manga',rows,{filter:{categoryId:{isNull:true}}}).nodes[0].id,2);
});
test('real WebUI duplicate-title query and source/reader/library/history filters',()=>{
  const queries=[['Manga',{title:{likeInsensitive:'alpha'}}],['Chapter',{mangaId:{in:[1]},scanlator:{notIncludesInsensitiveAny:['excluded']}}],['Manga',{inLibrary:{equalTo:true},categoryId:{isNull:false,in:[1]}}],['Chapter',{lastReadAt:{isNull:false,notEqualToAll:['0']}}],['Extension',{contentWarning:{greaterThanOrEqualTo:'MIXED'}}],['Manga',{inLibrary:{equalTo:false},categoryId:{isNull:false}}]];
  for(const [type,filter] of queries)assert.doesNotThrow(()=>validateFilter(filter,type));
  assert.deepEqual(connection('Manga',[{id:1,title:'Alpha',inLibrary:true},{id:2,title:'ALPHA',inLibrary:true},{id:3,title:'Alpha x',inLibrary:true}],{condition:{inLibrary:true},filter:{title:{likeInsensitive:'alpha'}}}).nodes.map(row=>row.id),[1,2]);
});
test('AST audit checks every filter object literal actually sent by the pinned WebUI',{skip:webuiSkip},async()=>{
  const webui=webuiUrl,require=createRequire(new URL('package.json',webui));
  const ts=require('typescript');
  const paths=listFiles(new URL('src/',webui).pathname,path=>/\.tsx?$/.test(path)&&!path.includes('/generated/'));
  const literals=[],seen=new Set();
  for(const path of paths){
    const text=await readFile(path,'utf8'),source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
    function visit(node){
      if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='filter'&&ts.isObjectLiteralExpression(node.initializer)){
        const leaf=[];
        for(const field of node.initializer.properties){
          assert.ok(ts.isPropertyAssignment(field)&&ts.isObjectLiteralExpression(field.initializer),'Review new nonliteral GraphQL filter');
          const name=field.name.getText(source);
          for(const operator of field.initializer.properties){
            assert.ok(ts.isPropertyAssignment(operator),'Review new spread/computed filter');
            const operation=operator.name.getText(source);leaf.push([name,operation]);seen.add(name+'.'+operation);
          }
        }
        const candidates=Object.entries(filterTypes).filter(([,fields])=>leaf.every(([field,operation])=>fields[field]&&supportsFilterOperator(fields[field],operation)));
        assert.ok(candidates.length,'Unclassified WebUI filter in '+path);literals.push(leaf);
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
  assert.equal(literals.length,8,'Review newly added/removed WebUI filter calls');
  assert.deepEqual([...seen].sort(),['categoryId.in','categoryId.isNull','contentWarning.greaterThanOrEqualTo','inLibrary.equalTo','lastReadAt.isNull','lastReadAt.notEqualToAll','mangaId.in','scanlator.notIncludesInsensitiveAny','title.likeInsensitive']);
});
test('filtering uses stored SQL values rather than thumbnail proxies or fallback real URLs',async()=>{
  const manager={sources:async()=>[],list:async()=>[]};
  const api=new BrowserBackend(new MemoryStore(),{manager,autoDownloads:false,autoUpdates:false});await api.loading;
  try{
    api.db.mangas.push({id:10,sourceId:'1',url:'/x',title:'Synthetic',genre:'A, B',thumbnailUrl:'https://fixture.invalid/cover',realUrl:null,categoryIds:[0]});
    await api.save();
    assert.equal((await api.resolve('mangas',{filter:{thumbnailUrl:{startsWith:'https://fixture.invalid/'},genre:{equalTo:'A, B'},realUrl:{isNull:true}}})).totalCount,1);
    assert.equal(Object.keys(api.manga(api.db.mangas[0])).includes('browser SQL filter values'),false);
    api.db.mangas[0].genre=['A','B'];await api.save();
    await assert.rejects(api.resolve('mangas',{filter:{genre:{equalTo:'A,B'}}}),/Refresh legacy/);
    api.rememberManga('1',{url:'/x',title:'Synthetic',genre:'A,B'},{details:true});await api.save();
    assert.equal((await api.resolve('mangas',{filter:{genre:{equalTo:'A,B'}}})).totalCount,1);
  }finally{api.dispose();}
});

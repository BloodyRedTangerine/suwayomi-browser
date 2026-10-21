// Synthetic fixture library values only; never live-source data.
export const scalarOperators=['distinctFrom','distinctFromAll','distinctFromAny','equalTo','greaterThan','greaterThanOrEqualTo','in','isNull','lessThan','lessThanOrEqualTo','notDistinctFrom','notEqualTo','notEqualToAll','notEqualToAny','notIn'];
export const stringOperators=[...scalarOperators];
for(const base of ['includes','startsWith','endsWith','like','notIncludes','notStartsWith','notEndsWith','notLike'])
  for(const insensitive of ['','Insensitive'])for(const quantifier of ['','All','Any'])stringOperators.push(base+insensitive+quantifier);
for(const base of ['distinctFrom','notDistinctFrom','in','notIn','lessThan','lessThanOrEqualTo','greaterThan','greaterThanOrEqualTo'])
  for(const quantifier of base==='distinctFrom'?['','All','Any']:[''])stringOperators.push(base+'Insensitive'+quantifier);
export const typeValues={
  String:[null,'','Alpha','alpha','ALPHA','Alphabet','100%_done','100xxdone','line\nbreak','slash\\tail','😀','İ','ı','Straße','STRASSE'],
  Int:[null,-1,0,1,2,2147483647],
  Long:[null,'-9223372036854775808','-1','0','1','9007199254740992','9223372036854775807'],
  Double:[null,-1.5,0,1,2.5,1e9],Boolean:[null,false,true],
  MangaStatus:[null,'UNKNOWN','ONGOING','COMPLETED','LICENSED','PUBLISHING_FINISHED','CANCELLED','ON_HIATUS'],
  ContentWarning:[null,'SAFE','MIXED','NSFW'],
};
const samples={String:['Alpha','zzz'],Int:[0,1],Long:['0','1'],Double:[0,1],Boolean:[false,true],MangaStatus:['UNKNOWN','ONGOING'],ContentWarning:['SAFE','MIXED']};
export function parityCases(){
  const cases=[];
  for(const [type,values] of Object.entries(typeValues)){
    const operators=type==='String'?stringOperators:scalarOperators;
    for(const operation of operators){
      const array=/(All|Any)$/.test(operation)||['in','inInsensitive','notIn','notInInsensitive'].includes(operation);
      const expected=operation==='isNull'?true:array?samples[type]:samples[type][0];
      cases.push({id:type+'.'+operation,type,filter:{[operation]:expected},values});
      if(array)cases.push({id:type+'.'+operation+'.empty',type,filter:{[operation]:[]},values});
    }
    cases.push({id:type+'.null-inputs',type,filter:Object.fromEntries(operators.map(operator=>[operator,null])),values});
  }
  for(const pattern of ['%','_','\\%','100\\%\\_done','100%done','line_break','slash\\\\tail','slash\\tail','bad\\','😀','i','ss','stra_e','a%a%a%'])
    for(const operation of ['like','likeInsensitive','notLikeInsensitive'])cases.push({id:'pattern.'+operation+'.'+JSON.stringify(pattern),type:'String',filter:{[operation]:pattern},values:typeValues.String});
  cases.push({id:'Long.precision',type:'Long',filter:{greaterThan:'9007199254740991'},values:typeValues.Long});
  for(const [operator,operand] of [['equalTo',0.1],['lessThan',0.10000001]])cases.push({id:'Double.chapter-float.'+operator,type:'Double',floatColumn:true,filter:{[operator]:operand},values:[null,0.1,0.10000000149011612,0.1000001,1]});
  return cases;
}

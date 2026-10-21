// Desktop reference: graphql/queries/filter/Filter.kt (Exposed/H2).
// undefined = omitted SQL clause; null = SQL UNKNOWN, not JavaScript false.
export const filterFields = Symbol('browser SQL filter values');
export const filterTypes = {
  Category: {default:'Boolean',id:'Int',name:'String',order:'Int'},
  Chapter: {chapterNumber:'Double',fetchedAt:'Long',id:'Int',inLibrary:'Boolean',isBookmarked:'Boolean',isDownloaded:'Boolean',isRead:'Boolean',lastPageRead:'Int',lastReadAt:'Long',mangaId:'Int',name:'String',pageCount:'Int',realUrl:'String',scanlator:'String',sourceOrder:'Int',uploadDate:'Long',url:'String'},
  Extension: {apkName:'String',apkUrl:'String',contentWarning:'ContentWarning',extensionLib:'String',hasUpdate:'Boolean',iconUrl:'String',isInstalled:'Boolean',isObsolete:'Boolean',jarUrl:'String',lang:'String',name:'String',pkgName:'String',storeIndexUrl:'String',versionCodeLong:'Long',versionName:'String'},
  ExtensionStore: {indexUrl:'String',name:'String'},
  Manga: {artist:'String',author:'String',categoryId:'Int',chaptersLastFetchedAt:'Long',description:'String',genre:'String',id:'Int',inLibrary:'Boolean',inLibraryAt:'Long',initialized:'Boolean',lastFetchedAt:'Long',realUrl:'String',sourceId:'Long',status:'MangaStatus',thumbnailUrl:'String',title:'String',url:'String'},
  Meta: {key:'String',value:'String'},
  Source: {contentWarning:'ContentWarning',id:'Long',lang:'String',name:'String'},
  TrackRecord: {finishDate:'Long',id:'Int',lastChapterRead:'Double',libraryId:'Long',mangaId:'Int',private:'Boolean',remoteId:'Long',remoteUrl:'String',score:'Double',startDate:'Long',status:'Int',title:'String',totalChapters:'Int',trackerId:'Int'},
};
const enums = {
  MangaStatus: ['UNKNOWN','ONGOING','COMPLETED','LICENSED','PUBLISHING_FINISHED','CANCELLED','ON_HIATUS'],
  ContentWarning: ['SAFE','MIXED','NSFW'],
};
const scalar = new Set(['isNull','equalTo','notEqualTo','notEqualToAll','notEqualToAny','distinctFrom','distinctFromAll','distinctFromAny','notDistinctFrom','in','notIn','lessThan','lessThanOrEqualTo','greaterThan','greaterThanOrEqualTo']);
const stringInsensitive = new Set(['distinctFrom','distinctFromAll','distinctFromAny','notDistinctFrom','in','notIn','lessThan','lessThanOrEqualTo','greaterThan','greaterThanOrEqualTo']);
export function supportsFilterOperator(type, operation) {
  if(type==='Float')type='Double'; // ChapterQuery converts DoubleFilter to FloatFilter.
  if (scalar.has(operation)) return ['String','Int','Long','Double','Boolean','MangaStatus','ContentWarning',undefined].includes(type);
  if (type !== 'String' && type !== undefined) return false;
  if (/^(?:includes|startsWith|endsWith|like|notIncludes|notStartsWith|notEndsWith|notLike)(?:Insensitive)?(?:All|Any)?$/.test(operation)) return true;
  // Insensitive is before the quantifier in the generated schema.
  const base=operation.replace('Insensitive','');
  return operation.includes('Insensitive') && stringInsensitive.has(base);
}
function combine(a,b,kind) {
  if(a===undefined)return b;if(b===undefined)return a;
  if(kind==='and')return a===false||b===false?false:a===null||b===null?null:true;
  return a===true||b===true?true:a===null||b===null?null:false;
}
const negate = value => value == null ? value : !value;
function normalized(value,type,insensitive=false) {
  if(value==null)return null;
  if(type==='Long') {
    if(typeof value==='number'&&!Number.isSafeInteger(value))throw new TypeError('Long filter requires an exact integer');
    if(!/^-?\d+$/.test(String(value)))throw new TypeError('Long filter requires a decimal integer');
    const integer=BigInt(value);if(integer < -(1n<<63n)||integer >= 1n<<63n)throw new RangeError('Long filter exceeds signed 64 bits');return integer;
  }
  if(enums[type]){const rank=enums[type].indexOf(value);if(rank<0)throw new TypeError('Invalid '+type+' filter value');return rank;}
  if(type==='Int'&&(!Number.isInteger(value)||value < -2147483648||value>2147483647))throw new TypeError('Int filter requires a signed 32-bit integer');
  if((type==='Double'||type==='Float')&&(typeof value!=='number'||!Number.isFinite(value)))throw new TypeError('Numeric filter requires a finite number');
  if(type==='Float'){const single=Math.fround(value);if(!Number.isFinite(single))throw new RangeError('Chapter filter exceeds Float range');return single;}
  if(type==='Boolean'&&typeof value!=='boolean')throw new TypeError('Boolean filter requires a Boolean');
  if(type==='String'&&typeof value!=='string')throw new TypeError('String filter requires a string');
  return insensitive&&typeof value==='string'?value.toUpperCase():value;
}
// H2 LIKE is anchored, uses '%' and '_' and a default backslash escape.
// Work in UTF-16 units like H2. Do not turn many '%' into a backtracking
// regular expression: a source title must not be able to hang the library UI.
export function sqlLike(actual,pattern,insensitive=false) {
  if(insensitive){
    // H2 uses Java Character case folding, not full String uppercase expansion.
    const fold=value=>value.split('').map(char=>{
      if(char==='İ')return 'i';
      const upper=char.toUpperCase(),unit=upper.length===1?upper:char;
      const lower=unit.toLowerCase();return lower.length===1?lower:unit;
    }).join('');
    actual=fold(actual);pattern=fold(pattern);
  }
  const many=Symbol('percent'),one=Symbol('underscore'),tokens=[];
  for(let i=0;i<pattern.length;i++){
    const char=pattern[i];
    if(char==='\\'){if(++i===pattern.length)return null;tokens.push(pattern[i]);}
    else if(char==='%'){if(tokens.at(-1)!==many)tokens.push(many);}
    else tokens.push(char==='_'?one:char);
  }
  let text=0,token=0,star=-1,retry=0;
  while(text<actual.length){
    if(tokens[token]===one||tokens[token]===actual[text]){text++;token++;}
    else if(tokens[token]===many){star=token++;retry=text;}
    else if(star>=0){token=star+1;text=++retry;}
    else return false;
  }
  while(tokens[token]===many)token++;
  return token===tokens.length;
}
function scalarClause(actual,operation,expected,type) {
  if(!supportsFilterOperator(type,operation))throw new Error('Unsupported '+(type||'scalar')+' filter operator '+operation);
  if(expected==null)return undefined; // Kotlin nullable input is an omitted clause.
  // Desktop MangaStatusFilter.asIntFilter omits its isNull property.
  if(operation==='isNull'){if(typeof expected!=='boolean')throw new TypeError('isNull requires Boolean');return type==='MangaStatus'?undefined:expected?actual==null:actual!=null;}
  const quantifier=/(All|Any)$/.exec(operation)?.[1];
  let base=operation.replace(/(All|Any)$/,'');
  const insensitive=base.endsWith('Insensitive');base=base.replace(/Insensitive$/,'');
  const isList=quantifier||base==='in'||base==='notIn';
  if(isList&&(!Array.isArray(expected)||expected.some(value=>value==null)))throw new TypeError(operation+' requires a non-null value array');
  if(isList&&!expected.length)return insensitive&&(base==='in'||base==='notIn')?base==='notIn':undefined;
  const compare=value=>{
    const a=normalized(actual,type,insensitive),b=normalized(value,type,insensitive);
    // Untyped internal fixture rows retain exact numeric Long-string equality.
    const eq=a===b || (!type&&Number.isSafeInteger(a)&&typeof b==='string'&&/^-?\d+$/.test(b)&&BigInt(a)===BigInt(b));
    if(base==='distinctFrom')return a===null?b!==null:!eq;
    if(base==='notDistinctFrom')return a===null?b===null:eq;
    if(a===null)return null;
    if(base==='equalTo')return eq;if(base==='notEqualTo')return !eq;
    if(base==='lessThan')return a<b;if(base==='lessThanOrEqualTo')return a<=b;
    if(base==='greaterThan')return a>b;if(base==='greaterThanOrEqualTo')return a>=b;
    if(base==='in'||base==='notIn')return eq;
    const negative=base.startsWith('not');
    const name=negative?base[3].toLowerCase()+base.slice(4):base;
    if(typeof actual!=='string'||typeof value!=='string')throw new TypeError('Pattern filters require strings');
    const pattern=name==='includes'?'%'+value+'%':name==='startsWith'?value+'%':name==='endsWith'?'%'+value:value;
    const result=sqlLike(actual,pattern,insensitive);return negative?negate(result):result;
  };
  if(base==='in'||base==='notIn'){
    const result=expected.reduce((value,item)=>combine(value,compare(item),'or'),undefined);
    return base==='notIn'?negate(result):result;
  }
  if(!quantifier)return compare(expected);
  // OpAnd.andNotWhereAll = OR of negative clauses; Any = AND.
  const negative=/^not(?:EqualTo|Includes|StartsWith|EndsWith|Like)$/.test(base);
  const conjunction=(quantifier==='All')!==negative?'and':'or';
  return expected.reduce((value,item)=>combine(value,compare(item),conjunction),undefined);
}
function objectClause(row,filter,type,categoryId) {
  if(filter==null)return undefined;
  if(typeof filter!=='object'||Array.isArray(filter))throw new TypeError('Filter requires an object');
  const fields=filterTypes[type], values=row[filterFields]||{};
  let result;
  for(const [field,operations] of Object.entries(filter)) {
    if(['and','or','not'].includes(field))continue;
    if(fields&&!Object.hasOwn(fields,field))throw new Error('Unsupported '+type+' filter field '+field);
    if(operations==null)continue;
    if(typeof operations!=='object'||Array.isArray(operations))throw new TypeError('Field filter requires an operator object');
    const actual=field==='categoryId'&&type==='Manga'?categoryId:Object.hasOwn(values,field)?values[field]:row[field];
    if(type==='Manga'&&field==='genre'&&Array.isArray(actual)&&Object.values(operations).some(value=>value!=null))throw new Error('Refresh legacy manga details before filtering its original genre string');
    const scalarType=type==='Chapter'&&field==='chapterNumber'?'Float':fields?.[field];
    for(const [operator,operand] of Object.entries(operations))result=combine(result,scalarClause(actual,operator,operand,scalarType),'and');
  }
  for(const part of filter.and||[])result=combine(result,objectClause(row,part,type,categoryId),'and');
  for(const part of filter.or||[])result=combine(result,objectClause(row,part,type,categoryId),'or');
  if(filter.not!=null)result=combine(result,negate(objectClause(row,filter.not,type,categoryId)),'and');
  return result;
}
export function validateFilter(filter,type) {
  type=type==='GlobalMeta'?'Meta':type;
  if(filter==null)return;
  if(typeof filter!=='object'||Array.isArray(filter))throw new TypeError('Filter requires an object');
  for(const [field,operations] of Object.entries(filter)){
    if(field==='and'||field==='or'){
      if(operations==null)continue;
      if(!Array.isArray(operations)||operations.some(part=>part==null))throw new TypeError(field+' requires a non-null filter array');
      for(const part of operations)validateFilter(part,type);
    }else if(field==='not')validateFilter(operations,type);
    else{
      if(filterTypes[type]&&!Object.hasOwn(filterTypes[type],field))throw new Error('Unsupported '+type+' filter field '+field);
      if(operations==null)continue;
      if(typeof operations!=='object'||Array.isArray(operations))throw new TypeError('Field filter requires an operator object');
      const scalarType=type==='Chapter'&&field==='chapterNumber'?'Float':filterTypes[type]?.[field];
      for(const [operator,value] of Object.entries(operations))scalarClause(null,operator,value,scalarType);
    }
  }
}
export function matchesFilter(row,filter,type) {
  type=type==='GlobalMeta'?'Meta':type;
  const ids=type==='Manga'?(row.categoryIds||[]).filter(id=>id!==0):[];
  return (ids.length?ids:[null]).some(id=>{const result=objectClause(row,filter,type,id);return result===undefined||result===true;});
}
export function withFilterValues(row,values) {Object.defineProperty(row,filterFields,{value:values});return row;}

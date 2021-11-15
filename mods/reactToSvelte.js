const { existsSync, readFileSync, writeFileSync } = require('fs');
const { basename, dirname, parse, relative } = require('path');

let modConf;
if (process.env.MOD_CONF) modConf = require(process.env.MOD_CONF);
if (!modConf) throw Error('Missing "MOD_CONF" env. variable');
if (!modConf.outputPath) throw Error('Missing "outputPath" in "MOD_CONF"');

function setModuleSource(node, val, token) {
  if (token) {
    node.raw = node.raw.replace(token, val);
    node.value = node.value.replace(token, val);
  }
  else {
    node.raw = `'${val}'`;
    node.value = val;
  }
}

const aliasToRelativePath = ({
  alias,
  aliasAbsPath,
  modulePath,
  outputPath,
}) => {
  const transformed = modulePath.replace(alias, aliasAbsPath);
  let relativePath = relative(outputPath, transformed);

  if(!relativePath.startsWith('.')) relativePath = `./${ relativePath }`;
  
  return relativePath;
};

const parseNestedStyles = (css) => {
  const ruleNames = [];
  let bracketIndent = '';
  const rawLines = css.split('\n');
  let rulesOffset;
  const lines = rawLines.reduce((arr, line) => {
    if (line === '--') return arr;
    
    let _line = line;
    
    if (!rulesOffset) {
      const space = (_line.match(/^\s+/) || [''])[0];
      rulesOffset = new RegExp(`^${space}`);
    }
    
    _line = _line.replace(rulesOffset, '');
    
    if (_line.includes('}')) {
      ruleNames.pop();
      if (ruleNames.length) return arr;
    }
    else if (_line.includes('{') && !_line.includes('}')) {
      bracketIndent = (_line.match(/^\s+/) || [''])[0];
      ruleNames.push((_line.match(/^(?:\s+)?([^ {]+) {/) || [,''])[1]);
    
      const nestedRuleName = ruleNames.join(' ').replace(' &', '');
      _line = `${bracketIndent}${nestedRuleName} {`;
    
      // remove empty parent
      const nextLine = rawLines[arr.length + 1];
      if (!nextLine.trim()) {
        rawLines[arr.length + 1] = '--';
        return arr;
      }
    }
    
    const prevLine = arr[arr.length - 1];
    const trimmedLine = _line.trim();
    
    // close current rule
    if (prevLine && !prevLine.includes('}') && trimmedLine === '') {
      _line = '}';
    }
    else if (trimmedLine === '' && prevLine.trim() === '') {
      return arr;
    }
    
    // remove nested indentation
    if (ruleNames.length > 1 && bracketIndent) {
      _line = _line.replace(new RegExp(`^${bracketIndent}`), '');
    }
    
    arr.push(_line);
    
    return arr;
  }, []);
  
  return lines;
};

const getParentBody = (np) => {
  return (np.name === 'body') ? np.node.body : getParentBody(np.parentPath);
};

module.exports = function transformer(file, api) {
  const fullFilePath = file.path;
  const fileContents = file.source;
  const jsCS = api.jscodeshift;
  const recastOpts = { // https://github.com/benjamn/recast/blob/master/lib/options.ts
    quote: 'single',
    tabWidth: 2,
  };
  
  const fileFolder = dirname(fullFilePath);
  let fileName = parse(basename(fullFilePath)).name;
  if (fileName === 'index') fileName = basename(fileFolder);
  
  const root = jsCS(fileContents);
  
  // [imports] =================================================================
  const imports = [];
  const cssVarMap = {};
  let cssRules;
  
  const templateLiteralToString = ({ expressions, quasis }) => {
    let str = '';
    quasis.forEach((q, ndx) => {
      const exp = expressions[ndx] ? cssVarMap[expressions[ndx].name] : '';
      str += `${q.value.raw}${exp}`;
    });
    return str;
  };
  
  root.find(jsCS.ImportDeclaration)
  	.filter((np) => {
      const modulePath = np.value.source.value;
      return !/(react|prop-types)/.test(modulePath);
  	})
    .forEach((np) => {
      const moduleSrc = np.value.source;
      const { aliases, moduleReplacements, outputPath } = modConf;
      let keep = true;
      let pathAltered = false;
      
      if (moduleReplacements) {
        for (let i=0; i<moduleReplacements.length; i++) {
          const [query, matcher, replacement] = moduleReplacements[i];
          
          if (query.test(moduleSrc.value)) {
            setModuleSource(moduleSrc, replacement, matcher);
            pathAltered = true;
            break;
          }
        }
      }
      
      if (aliases) {
        const a = Object.keys(aliases);
        let alias;
        
        for (let i=0; i<a.length; i++) {
          const _alias = a[i];
          
          if (moduleSrc.value.startsWith(_alias)) {
            alias = [_alias, aliases[_alias]];
            break;
          }
        }
        
        if (alias) {
          const relativePath = aliasToRelativePath({
            alias: alias[0],
            aliasAbsPath: alias[1],
            modulePath: moduleSrc.value,
            outputPath,
          });
          setModuleSource(moduleSrc, relativePath);
          pathAltered = true;
        }
      }
      
      if (pathAltered) {
        let fullModulePath = `${modConf.outputPath}/${moduleSrc.value}`;
        if (!parse(fullModulePath).ext) fullModulePath = `${fullModulePath}.js`;
        if (!existsSync(fullModulePath)) {
          console.warn([
            `[WARN] "${fileName}" won't be able to access:`,
            `       "${fullModulePath}"`,
          ].join('\n'));
        }
      }
      
      if (moduleSrc.value.endsWith('styles')) {
        keep = false;
        
        const styles = (moduleSrc.value.startsWith('.'))
          ? readFileSync(`${fileFolder}/${moduleSrc.value}.js`, 'utf8')
          : readFileSync(`${moduleSrc.value}.js`, 'utf8');
        const stylesRoot = jsCS(styles);
        const cssNode = stylesRoot.find(jsCS.TaggedTemplateExpression, { tag: { name: 'css' } }).get().node.quasi;
        
        stylesRoot.find(jsCS.VariableDeclarator, { init: { type: 'Literal' } }).forEach((np) => {
          const { id, init } = np.node;
          cssVarMap[id.name] = init.value;
        });
        
        const WRAPPED_SPACE = '  ';
        let unwrappedRootRule = false;
        const cssLines = templateLiteralToString(cssNode)
          .replace(/^\n/, '').replace(/\n$/, '')
          .split('\n')
          .map((line, ndx) => {
            let _line = line;
            
            if (ndx === 0 && !_line.includes('{')) {
              unwrappedRootRule = true;
              _line = `.${cssVarMap.ROOT_CLASS} {\n${WRAPPED_SPACE}${_line}`;
            }
            if (unwrappedRootRule) {
              if (_line.trim() === '') {
                _line = `${WRAPPED_SPACE}}\n`;
                unwrappedRootRule = false;
              }
              else {
                _line = `${WRAPPED_SPACE}${_line}`;
              }
            }
            
            return _line;
          });
        
        cssRules = parseNestedStyles(cssLines.join('\n'));
      }
      
      if (keep) imports.push(jsCS(np.node).toSource(recastOpts));
    });
  
  // [ constructor ] ===========================================================
  
  const constructMethod = root.find(jsCS.MethodDefinition, { key: { name: 'constructor' } });
  let internalState = [];
  let refs = [];
  
  if (constructMethod.length) {
    // [ internal state ] ======================================================
    
    const constructNode = jsCS(constructMethod.get().node);
    const initState = constructNode.find(jsCS.MemberExpression, { property: { name: 'state' } });
    
    if (initState.length) {
      const stateProps = initState.get().parentPath.node.right.properties;
      internalState = stateProps.map((node) => {
        return [node.key.name, node.value.raw];
      });
    }
    
    // [ createRef ] ===========================================================
    
    const createRef = root.find(jsCS.CallExpression, { callee: { property: { name: 'createRef' } } });
    if (createRef.length) {
      createRef.forEach((np) => {
        const refName = np.parentPath.node.left.property.name;
        refs.push([refName]);
        
        // Find anything using `this.<refName>.current[.<prop>]` and remove 
        // references to `this` and `current`.
        root
          .find(jsCS.MemberExpression, {
            object: {
              object: {
                object: { type: 'ThisExpression' },
                property: { name: refName },
              },
              property: { name: 'current' },
            },
          })
          .replaceWith((np) => {
            const currentProp = np.node.property.name;
            return currentProp
              ? jsCS.memberExpression(jsCS.identifier(refName), jsCS.identifier(currentProp))
              : jsCS.identifier(refName);
          });
      });
    }
  }
  
  // [ props ] =================================================================
  
  let propVars = [];
  
  // function calls
  root
    .find(jsCS.CallExpression, {
      callee: {
        object: {
          object: { type: 'ThisExpression' },
          property: { name: 'props' },
        },
      },
    })
    .replaceWith((np) => {
      const fn = np.node.callee.property;
      const fnArgs = np.node.arguments;
      propVars.push([fn.name]);
      return jsCS.callExpression(fn, fnArgs);
    });
  
  // prop destructuring
  root
    .find(jsCS.VariableDeclaration, {
      declarations: [{
        init: {
          object: { type: 'ThisExpression' },
          property: { name: 'props' },
        },
      }],
    })
    .replaceWith((np) => {
      const props = np.node.declarations[0].id.properties;
      props.forEach((prop) => { propVars.push([prop.key.name]); });
      
      // not returning so that the line is deleted.
    });
  
  // [ state ] =================================================================
  
  let stateVars = [];
  
  // state destructuring
  root
    .find(jsCS.VariableDeclaration, {
      declarations: [{
        init: {
          object: { type: 'ThisExpression' },
          property: { name: 'state' },
        },
      }],
    })
    .replaceWith((np) => {
      const props = np.node.declarations[0].id.properties;
      props.forEach((prop) => { stateVars.push([prop.key.name]); });
      
      // not returning so that the line is deleted.
    });
  
  // setState calls
  root
    .find(jsCS.CallExpression, {
      callee: {
        object: { type: 'ThisExpression' },
        property: { name: 'setState' },
      },
    })
    .forEach((np) => {
      const assignments = np.node.arguments[0].properties.map((n) => {
        return jsCS.expressionStatement(jsCS.assignmentExpression('=', n.key, n.value));
      });
      
      const body = getParentBody(np);
      const bodyNdx = body.findIndex((n, ndx) => n.start === np.node.start);
      body.splice(bodyNdx, 1, ...assignments);
    });
  
  // [ remaining 'this.' references ] ==========================================
  
  // function calls
  root
    .find(jsCS.ExpressionStatement, {
      expression: {
        callee: {
          object: { type: 'ThisExpression' },
        },
      },
    })
    .replaceWith((np) => {
      const n = np.node.expression;
      return jsCS.callStatement(n.callee.property, n.arguments);
    });
  
  // ===========================================================================
  
  // jsCS.types.Type.def('SvelteIf')
  //   .bases('IfStatement')
  //   .build('name', 'program')
  //   .field('name', jsCS.types.builtInTypes.string)
  //   .field('program', jsCS.types.Type.def('Program'));
  // jsCS.types.finalize();
  
  const removeThis = (expr) => {
    let propName;
    
    if (expr.object && expr.object.type && expr.object.type === 'ThisExpression') {
      propName = expr.property.name;
      expr.name = propName;
      expr.type = 'Identifier';
    }
    
    return propName;
  }
  
  root.find(jsCS.JSXIdentifier).forEach((np) => {
    const attrName = np.value.name;
    if (attrName === 'className') np.value.name = 'class';
    else if (attrName === 'defaultValue') np.value.name = 'value';
    else if (attrName.startsWith('on')) {
      const parentName = np.parentPath.parentPath.parentPath.value.name.name;
      const standardDomNode = /[a-z]/.test(parentName[0]);
      
      removeThis(np.parentPath.value.value.expression);
      
      if (standardDomNode) {
        const [, type] = attrName.split('on');
        np.value.name = `on:${type.toLowerCase()}`;
      }
    }
    else if (attrName === 'ref') {
      np.value.name = 'bind:this';
      refs.push([removeThis(np.parentPath.value.value.expression)]);
    }
  });
  
  const getOp = (op) => {
    let _op = op.operator || op.name;
    if (op.argument) _op += getOp(op.argument);
    return _op;
  };
  root.find(jsCS.LogicalExpression).forEach((np) => {
    if (np.value.operator === '&&') {
      const leftOp = getOp(np.value.left);
      console.log(leftOp);
    }
  });
  
  // TODO:
  // [import]
  // [props]
  // [state]
  // [refs]
  // [this]
  // - Revisit `removeThis` calls now that I know more
  // [markup]
  // - `class={`${ ROOT_CLASS } ${ styles }`}`
  //   - Remove ` ${ styles }`
  //   - Get `ROOT_CLASS` value from `styles.js` and swap it in.
  //   - If there aren't anymore template strings, change to quoted item
  // - Replace blocks `{!!seriesAlias && (` with custom `{#if}`
  // - Something's off with the internal spacing of the nested items
  
  const isClassComponent = !!root.find(jsCS.ClassDeclaration).length;
  const methods = [];
  let markup = [];
  if (isClassComponent) {
    root.find(jsCS.MethodDefinition).forEach((np) => {
      const methodName = np.value.key.name;
      
      switch(methodName) {
        case 'constructor': break;
        case 'render': {
          const returnNode = jsCS(np).find(jsCS.ReturnStatement).get().value.argument;
          markup = jsCS([returnNode.openingElement, ...returnNode.children, returnNode.closingElement]).toSource(recastOpts);
          break;
        }
        default: {
          let funcDef = jsCS(np).toSource(recastOpts);
          const funcLines = funcDef.split('\n');
          funcLines[0] = `function ${funcLines[0]}`;
          funcDef = funcLines.join('\n');
          methods.push(funcDef);
        }
      }
    });
  }
  
  // [ output file ] ===========================================================
  
  const tabOver = (arr, space) => arr.map(n => n.split('\n').map(l => `${space}${l}`).join('\n'));
  const SCRIPT_SPACE = '  ';
  
  let script = [];
  if (imports.length) {
    script.push(
      tabOver(imports, SCRIPT_SPACE).join('\n'),
      SCRIPT_SPACE
    );
  }
  if (
    internalState.length
    || propVars.length
    || refs.length
    || stateVars.length
  ) {
    const vars = [];
    const deDupe = (arr, propArr) => {
      const [prop] = propArr;
      if (!arr.find(([p]) => p === prop)) arr.push(propArr);
      return arr;
    };
    const sortVars = ([propA], [propB]) => {
      const lowerPropA = propA.toLowerCase();
      const lowerPropB = propB.toLowerCase();
      const subCheck = (lowerPropB > lowerPropA) ? -1 : 0;
      return (lowerPropA > lowerPropB) ? 1 : subCheck;
    }
    
    if (propVars.length) {
      propVars = propVars.reduce(deDupe, []).sort(sortVars)
        .map(([prop, value = 'undefined']) => {
          return `export let ${prop} = ${value};`;
        });
      vars.push(tabOver(propVars, SCRIPT_SPACE).join('\n'));
    }
    
    let internalVars = [];
    // NOTE: the order of these additions are intentional
    if (internalState.length) internalVars.push(...internalState);
    if (refs.length) internalVars.push(...refs);
    if (stateVars.length) internalVars.push(...stateVars);
    
    if (internalVars.length) {
      internalVars = internalVars.reduce(deDupe, []).sort(sortVars)
        .map(([prop, value]) => {
          const val = (value !== undefined) ? ` = ${value}` : '';
          return `let ${prop}${val};`;
        });
      vars.push(tabOver(internalVars, SCRIPT_SPACE).join('\n'));
    }
    
    script.push(
      ...vars,
      SCRIPT_SPACE
    );
  }
  if (methods.length) {
    script.push(tabOver(methods, SCRIPT_SPACE).join('\n\n'));
  }
  if (script.length) {
    script = [
      '<script>',
      ...script,
      '</script>',
      '',
    ];
  }
  
  if (markup.length) {
    markup = [markup.join(''), ''];
  }
  
  if (cssRules.length) {
    cssRules = [
      '<style>',
      tabOver(cssRules, SCRIPT_SPACE).join('\n'),
      '</style>',
      '',
    ];
  }
  
  const output = [
    ...script,
    ...markup,
    ...cssRules,
  ].join('\n');
  
  writeFileSync(`${modConf.outputPath}/${fileName}.svelte`, output);
  
  return output;
}

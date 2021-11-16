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
  const lines = rawLines.reduce((arr, line, ndx) => {
    if (
      line === '--'
      || (ndx === 0 && line.trim() === '')
    ) return arr;
    
    let _line = line;
    
    // get initial offset within the 'css' template string
    if (!rulesOffset) {
      const space = (_line.match(/^\s+/) || [''])[0];
      rulesOffset = new RegExp(`^${space}`);
    }
    
    // trim offset
    _line = _line.replace(rulesOffset, '');
    
    // end of rule
    if (_line.includes('}')) {
      ruleNames.pop();
      if (ruleNames.length) return arr;
    }
    // start of rule
    else if (_line.includes('{') && !_line.includes('}')) {
      bracketIndent = (_line.match(/^\s+/) || [''])[0];
      ruleNames.push((_line.match(/^(?:\s+)?([^{]+) {/) || [,''])[1]);
      const ruleName = ruleNames.join(' ')
        // nested rules
        .replace(/ &/g, '')
        // top-level rules that would normally be prepended with a hashed rule
        .replace(/^&/, '');
      _line = `${bracketIndent}${ruleName} {`;
      
      // remove empty parent
      const nextLine = rawLines[ndx + 1];
      if (!nextLine.trim()) {
        rawLines[arr.length + 1] = '--';
        return arr;
      }
    }
    
    const prevLine = arr[arr.length - 1] || '';
    const trimmedLine = _line.trim();
    
    // close current parent rule (in nested scenario)
    if (prevLine && !prevLine.includes('}') && trimmedLine === '') {
      _line = '}';
    }
    // remove multiple blank lines
    else if (trimmedLine === '' && prevLine.trim() === '') {
      return arr;
    }
    
    // remove nested indentation
    if (ruleNames.length > 1 && bracketIndent) {
      _line = _line.replace(new RegExp(`^${bracketIndent}`), '');
    }
    
    // the first rule can sometimes be empty (when nested) so don't add it
    if (!arr.length && _line.trim() === '') return arr;
    
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
  let fnBody;
  
  const fileFolder = dirname(fullFilePath);
  let fileName = parse(basename(fullFilePath)).name;
  if (fileName === 'index') fileName = basename(fileFolder);
  
  const root = jsCS(fileContents);
  
  const renderNode = (value) => {
    let _value = value;
    if (typeof _value === 'object') _value = jsCS(_value).toSource();
    return _value;
  };
  
  // [imports] =================================================================
  const imports = [];
  const exportedCSSVars = {};
  let cssRules;
  
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
        let modulePath = moduleSrc.value;
        if (!parse(modulePath).ext) modulePath = `${modulePath}.js`;
        let fullModulePath = `${modConf.outputPath}/${modulePath}`;
        
        if (!existsSync(fullModulePath)) {
          console.warn([
            `[WARN] Module "${modulePath}"`,
            `       Not accessible from "${modConf.outputPath}/${fileName}.svelte"`,
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
        const cssVars = {};
        const rootVars = new Map();
        let initialSpace = '';
        let unwrappedRootRule = false;
        
        stylesRoot.find(jsCS.VariableDeclaration).forEach((np) => {
          const { type: parentType } = np.parentPath.node;
          const { id: { name }, init: { value } } = np.node.declarations[0];
          
          if (parentType === 'ExportNamedDeclaration') exportedCSSVars[name] = value;
          else cssVars[name] = value;
        });
        
        const templateLiteralToString = ({ expressions, quasis }) => {
          let str = '';
          let lineIndent = '';
          quasis.forEach((q, ndx) => {
            const varName = expressions[ndx] && expressions[ndx].name;
            let exp = exportedCSSVars[varName] || '';
            
            if (cssVars[varName]) {
              const cssVarName = `--${varName.toLowerCase().replace(/_/g, '-')}`;
              rootVars.set(cssVarName, cssVars[varName]);
              exp = `var(${cssVarName})`;
            }
            
            str += `${q.value.raw}${exp}`;
            
            if (ndx === 0) {
              const lineWithRule = str.split('\n').find(l => /[.a-z]/i.test(l));
              if (lineWithRule) lineIndent = lineWithRule.split('\n')[0].match(/^\s+/)[0];
            }
          });
          
          if (rootVars.size) {
            str = [
              `${lineIndent}:root {`,
              ...[...rootVars.entries()].map(([n, v]) => `${lineIndent}${lineIndent}${n}: ${v};`),
              `${lineIndent}}`,
              lineIndent,
              str,
            ].join('\n');
          }
          
          return str;
        };
        
        const cssLines = templateLiteralToString(cssNode)
          .replace(/^\n/, '').replace(/\n$/, '')
          .split('\n')
          .reduce((arr, line, ndx) => {
            const lineIsEmpty = line.trim() === '';
            let _line = line;
            
            if (!initialSpace) initialSpace = _line.match(/^(\s+)/)[1];
            
            if (ndx === 0 && !lineIsEmpty && !_line.includes('{')) {
              unwrappedRootRule = true;
              _line = `.${exportedCSSVars.ROOT_CLASS} {\n${initialSpace}${_line}`;
            }
            
            if (unwrappedRootRule) {
              if (lineIsEmpty) {
                _line = `${initialSpace}}\n`;
                unwrappedRootRule = false;
              }
              else {
                _line = `${initialSpace}${_line}`;
              }
            }
            
            arr.push(_line);
            
            return arr;
          }, []);
        
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
      internalState = stateProps.map(({ key, value }) => {
        return [key.name, value];
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
  
  // default props
  root
    .find(jsCS.AssignmentExpression, {
      left: { property: { name: 'defaultProps' } }
    })
    .forEach((np) => {
      np.node.right.properties.forEach(({ key, value }) => {
        propVars.push([key.name, value]);
      });
    });
  
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
  
  // from functional components
  root.find(jsCS.ExportDefaultDeclaration).forEach((np) => {
    if (np.node.declaration && np.node.declaration.name) {
      root.find(jsCS.VariableDeclarator, {
        id: { name: np.node.declaration.name }
      })
      .forEach((np) => {
        np.node.init.params[0].properties.forEach(({ key }) => {
          propVars.push([key.name]);
        });
        fnBody = np.node.init.body.body;
      });
    }
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
  
  // [ markup ] ================================================================
  
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
  
  // parse 'className' attributes
  // - change attribute to `class`
  // - compile any template strings and convert them to a string literal if no
  //   tokens remain after compiled.
  root
    .find(jsCS.JSXAttribute, {
      name: { name: 'className' },
    })
    .replaceWith((np) => {
      const node = np.node;
      node.name = 'class';
      if (node.value.type === 'JSXExpressionContainer') {
        const { expressions, quasis } = node.value.expression;
        const exp = [];
        const qwz = [];
        
        quasis.forEach(({ value }, ndx) => {
          const token = expressions[ndx];
          const val = { ...value };
          let append = false;
          
          if (token) {
            // replace tokens from CSS
            if (exportedCSSVars[token.name]) {
              val.cooked = `${val.cooked}${exportedCSSVars[token.name]}`;
              val.raw = `${val.raw}${exportedCSSVars[token.name]}`;
              append = true;
            }
            // omit certain tokens
            else if (token.name === 'styles') {
              append = true;
            }
            // add remaining tokens
            else {
              exp.push(token);
            }
          }
          
          if (append && qwz.length) {
            const q = qwz[qwz.length - 1].value;
            q.cooked = `${q.cooked}${val.cooked}`;
            q.raw = `${q.raw}${val.raw}`;
          }
          else if (!!val.raw.trim()) qwz.push(jsCS.templateElement(val, false));
        });
        
        node.value = (exp.length)
          ? jsCS.jsxExpressionContainer(jsCS.templateLiteral(qwz, exp))
          : jsCS.literal(qwz.reduce((str, { value }) => `${str}${value.raw}`, ''));
      }
      
      return node;
    });
  
  root.find(jsCS.JSXIdentifier).forEach((np) => {
    const attrName = np.value.name;
    if (attrName === 'defaultValue') np.value.name = 'value';
    else if (attrName === 'htmlFor') np.value.name = 'for';
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
  // [markup]
  // - Replace blocks `{!!seriesAlias && (` with custom `{#if}`
  // - Replace blocks `{items.map(` with custom `{#each}`
  // [processing]
  // - process a glob or multiple files at once?
  // - output all errors/warnings to one log file
  
  const isClassComponent = !!root.find(jsCS.ClassDeclaration).length;
  const methods = [];
  let markup = [];
  let miscRenderItems = [];
  
  if (isClassComponent) {
    root.find(jsCS.MethodDefinition).forEach((np) => {
      const methodName = np.value.key.name;
      
      switch(methodName) {
        case 'constructor': break;
        case 'render': {
          fnBody = np.node.value.body.body;
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
  
  if (fnBody) {
    const jsxEl = (ident) => (
      jsCS.jsxElement(
        jsCS.jsxOpeningElement(jsCS.jsxIdentifier(ident)),
        jsCS.jsxClosingElement(jsCS.jsxIdentifier(ident))
      )
    );
    
    fnBody.forEach((node) => {
      if (node) {
        if (node.type === 'VariableDeclaration') {
          const v = node.declarations[0].init.property;
          
          if (
            !v // normal variables
            || ( // destructured variables
              v && v.name
              && (v.name !== 'props' && v.name !== 'state')
            )
          ) {
            miscRenderItems.push(node);
          }
        }
        else if (node.type === 'ReturnStatement') {
          jsCS(node)
            .find(jsCS.JSXExpressionContainer, {
              expression: { name: 'children' },
            })
            .replaceWith(np => {
              const propNdx = propVars.findIndex(([p]) => p === 'children');
              propVars.splice(propNdx, 1);
              return jsxEl('slot');
            });
          
          markup = jsCS(node.argument).toSource({
            ...recastOpts,
            quote: 'double',
          }).split('\n');
        }
        else miscRenderItems.push(node);
      }
    });
    
    if (miscRenderItems.length) {
      const raw = jsCS(miscRenderItems).toSource().join('\n');
      miscRenderItems = [
        '',
        '// TODO: [manual refactor required] !!!!!!!',
        ...raw.split('\n'),
        '// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      ];
    }
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
          return `export let ${prop} = ${renderNode(value)};`;
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
          const val = (value !== undefined) ? ` = ${renderNode(value)}` : '';
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
  if (miscRenderItems.length) {
    script.push(tabOver(miscRenderItems, SCRIPT_SPACE).join('\n'));
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
    markup = [...markup, ''];
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

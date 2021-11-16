import React, { Component as ReactComponent } from 'react';
import { array, func, number, string } from 'prop-types';
import { API__UPDATE_DATA } from 'ROOT/conf.app';
import fetch from 'UTILS/fetch';
import styles, { ROOT_CLASS } from './styles';

class Component1 extends ReactComponent {  
  constructor() {
    super();
    
    this.state = {
      btnDisabled: true,
    };
     
    this.inputRef = React.createRef();
    
    this.handleChange = this.handleChange.bind(this);
    this.handleBtnClick = this.handleBtnClick.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }
  
  handleChange({ currentTarget: { value } }) {
    const { value1 } = this.props;
    const { btnDisabled } = this.state;
    
    if (!btnDisabled && value === value1) {
      console.log('random log');
      this.setState({ btnDisabled: true });
      console.log('another random log');
    }
    else if (btnDisabled && value !== value1) {
      this.setState({ btnDisabled: false });
    }
    
    this.props.onChange(value);
  }
  
  updateData(data) {
    const { onDataUpdate } = this.props;
    
    fetch(API__UPDATE_DATA, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
      .then((updatedData) => { onDataUpdate(updatedData); })
      .catch((err) => { alert(err); });
  }
  
  handleBtnClick() {
    this.updateData();
  }
  
  handleSubmit(ev) {
    ev.preventDefault();
    this.updateData(this.inputRef.current.value);
  }
  
  render() {
    const {
      items,
      value1,
      value2,
    } = this.props;
    const {
      btnDisabled,
    } = this.state;
    let rootModifier = '';
    
    if (items.length) {
      rootModifier = 'has--items';
    }
    
    return (
      <div className={`start ${ ROOT_CLASS } middle ${ styles } ${rootModifier}`}>
        <h3>A Title</h3>
        
        <form onSubmit={this.handleSubmit}>
          <input
            type="text"
            defaultValue={value2 || value1}
            ref={this.inputRef}
            onInput={this.handleChange}
          />
          
          <nav>
            <button
              type="button"
              onClick={this.handleCancelClick}
            >Cancel</button>
            <button
              disabled={btnDisabled}
            >Apply</button>
          </nav>
          
          {!!value2 && (
            <div className={`${ ROOT_CLASS }__some-section`}>
              Label: <span className={`${ ROOT_CLASS }__some-name`}>{value1}</span>
              
              <button
                type="button"
                onClick={this.handleBtnClick}
              >Remove</button>
            </div>
          )}
        </form>
        
        <ul>
          {items.map((item, ndx) => {
            <li key={ndx}>{item}</li>
          })}
        </ul>
      </div>
    );
  }
}

Component1.defaultProps = {
  items: [],
  value1: 'A Label',
};
Component1.propTypes = {
  items: array,
  onChange: func,
  onDataUpdate: func,
  value1: string,
  value2: string,
};

export default Component1;

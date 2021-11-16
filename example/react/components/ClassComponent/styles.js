import { css } from 'emotion';

export const ROOT_CLASS = 'component1';

export default css`
  max-width: 30em;
  overflow: auto;
  
  h3 {
    margin-top: 0;
  }
  
  form {
    margin: 0;
  }
  
  [type="text"] {
    width: 100%;
    font-size: 1em;
    padding: 0.25em;
  }
  
  nav {
    margin-top: 0.5em;
    display: flex;
    
    button {
      width: 100%;
    }
    
    button:not(:first-of-type) {
      margin-left: 0.5em;
    }
  }
  
  .${ ROOT_CLASS } {
    
    &__some-section {
      padding-top: 0.5em;
      border-top: solid 1px;
      margin-top: 0.5em;
      
      button {
        width: 100%;
        margin-top: 0.5em;
      }
    }
    
    &__some-name {
      color: #a755a4;
      font-weight: bold;
    }
  }
`;
